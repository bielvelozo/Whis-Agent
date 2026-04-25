// apps/worker/src/index.ts

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { createLogger } from '@whis/logger';
import {
  closeDatabase,
  MessageRepo,
  openDatabase,
  runMigrations,
  SessionRepo,
} from '@whis/storage';
import { parse as parseYaml } from 'yaml';
import { ClaudeCodeBackend } from '@/agent/backends/claude-code';
import { MockBackend } from '@/agent/backends/mock';
import { loadMockFixtures } from '@/agent/backends/mock-fixtures';
import { AgentCore } from '@/agent/core';
import { loadMcpConfig } from '@/agent/mcp';
import {
  buildSystemPrompt,
  loadAgentFile,
  loadAlwaysActiveSkills,
  loadProfileFile,
} from '@/agent/system-prompt';
import type { AgentBackend } from '@/agent/types';
import { WhatsAppChannel } from '@/channels/whatsapp/adapter';
import { EvolutionClient } from '@/channels/whatsapp/evolution-client';
import { type Config, loadConfig } from '@/config';
import { ProfileWatcher } from '@/profile/watcher';
import { buildWebhookApp } from '@/webhook/server';

function loadAlwaysActiveSkillNames(): string[] {
  for (const candidate of ['/app/profile/config.yaml', 'profile/config.yaml']) {
    try {
      const raw = readFileSync(candidate, 'utf8');
      const parsed = parseYaml(raw) as { always_active_skills?: string[] } | null;
      if (parsed?.always_active_skills && Array.isArray(parsed.always_active_skills)) {
        return parsed.always_active_skills;
      }
    } catch {
      // try next
    }
  }
  return [];
}

function buildBackend(config: Config): AgentBackend {
  if (config.backend === 'mock') {
    return new MockBackend(loadMockFixtures());
  }
  const mcpServers = loadMcpConfig();
  return new ClaudeCodeBackend({ mcpServers });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const bootLogger = createLogger({ service: 'worker', level: config.logLevel });
  bootLogger.info({ event: 'boot_start' }, 'Whis booting');

  const dbPath = join(config.dataDir, 'whis.db');
  const db = openDatabase(dbPath);
  bootLogger.info({ event: 'db_opened', path: dbPath }, 'database opened');
  runMigrations(db);
  bootLogger.info({ event: 'migrations_applied' }, 'migrations applied');

  const sessions = new SessionRepo(db);
  const messages = new MessageRepo(db);

  const alwaysActiveNames = loadAlwaysActiveSkillNames();
  const alwaysActiveContents = loadAlwaysActiveSkills(alwaysActiveNames);

  const buildPromptNow = (): string => {
    const soul = loadAgentFile('SOUL.md');
    const user = loadProfileFile('USER.md');
    return buildSystemPrompt(soul, user, alwaysActiveContents);
  };

  const promptHolder = { value: buildPromptNow() };
  const initialSoul = loadAgentFile('SOUL.md');
  if (initialSoul) bootLogger.info({ event: 'soul_md_loaded', bytes: initialSoul.length });
  const initialUser = loadProfileFile('USER.md');
  if (initialUser) bootLogger.info({ event: 'user_md_loaded', bytes: initialUser.length });
  else bootLogger.warn({ event: 'user_md_missing' }, 'USER.md not found');

  const evolutionClient = new EvolutionClient({
    baseUrl: config.evolution.baseUrl,
    apiKey: config.evolution.apiKey,
    instance: config.evolution.instance,
  });
  const evolutionOk = await evolutionClient.ping();
  if (evolutionOk) bootLogger.info({ event: 'evolution_health_ok' });
  else bootLogger.warn({ event: 'evolution_health_failed' }, 'evolution not reachable at boot');

  const channel = new WhatsAppChannel({ client: evolutionClient });

  const backend = buildBackend(config);
  bootLogger.info({ event: 'backend_selected', backend: backend.name });

  const core = new AgentCore({
    backend,
    workspaceDir: config.workspaceDir,
    getSystemPrompt: () => promptHolder.value,
    sessions,
    sessionIdleMs: config.sessionIdleHours * 3_600_000,
  });

  // Wrap channel.send antes de start() pra capturar todas as chamadas (inclusive as do core).
  // Trade-off conhecido: sem AsyncLocalStorage, não correlacionamos outbound com inbound;
  // gravamos `correlationId: 'outbound'` como compromisso. Fix planejado pós-MVP.
  const originalSend = channel.send.bind(channel);
  channel.send = async (target, text) => {
    const result = await originalSend(target, text);
    messages.insert({
      chatId: target.conversationId,
      direction: 'out',
      text,
      correlationId: 'outbound',
      messageRef: result.messageRef,
      at: Date.now(),
    });
    return result;
  };

  // Bind core ao channel uma única vez. Handler reusado a cada mensagem.
  const handleMessage = core.bind(channel);

  // Start channel — registra handler que (a) audita inbound e (b) chama core.
  await channel.start(async (msg) => {
    messages.insert({
      chatId: msg.conversationId,
      direction: 'in',
      text: msg.text,
      correlationId: msg.correlationId,
      messageRef: msg.messageRef,
      at: Date.now(),
    });
    await handleMessage(msg);
  });

  // Webhook server
  const app = buildWebhookApp({
    ownerNumber: config.whatsapp.ownerNumber,
    expectedApiKey: config.webhookRequireApiKey ? config.evolution.apiKey : null,
    onMessage: async (msg) => {
      // Channel handler é registrado em start() — envolvido aqui via dispatch direto.
      await channel.dispatch(msg);
    },
    healthCheck: async () => ({
      dbOpen: true,
      evolutionPing: await evolutionClient.ping(),
    }),
  });

  const server = serve({ fetch: app.fetch, port: config.webhookPort }, (info) => {
    bootLogger.info({ event: 'webhook_listening', port: info.port }, 'webhook server listening');
  });

  const watcher = new ProfileWatcher({
    onPromptFilesChanged: () => {
      promptHolder.value = buildPromptNow();
      bootLogger.info({ event: 'system_prompt_reloaded' });
    },
    onCronsChanged: () => {
      // sem cron no MVP
    },
    onMcpChanged: () => {
      bootLogger.warn({ event: 'mcp_change_requires_restart' });
    },
  });
  watcher.start();

  bootLogger.info({ event: 'whis_online' }, 'Whis online');

  const shutdown = async (signal: string): Promise<void> => {
    bootLogger.info({ event: 'shutdown', signal });
    try {
      watcher.stop();
    } catch {
      /* best effort */
    }
    try {
      await channel.stop();
    } catch {
      /* best effort */
    }
    try {
      server.close();
    } catch {
      /* best effort */
    }
    try {
      closeDatabase(db);
    } catch {
      /* best effort */
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  const fatal = createLogger({ service: 'worker' });
  fatal.fatal({ event: 'boot_failed', err: String(error) }, 'boot failed');
  process.exit(1);
});
