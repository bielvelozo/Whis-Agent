// apps/worker/src/index.ts

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { createLogger } from '@whis/logger';
import {
  closeDatabase,
  HabitLogRepo,
  HabitRepo,
  MessageRepo,
  openDatabase,
  runMigrations,
  ScheduledMessageRepo,
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
import { TelegramChannel } from '@/channels/telegram/adapter';
import type { Channel } from '@/channels/types';
import { WhatsAppChannel } from '@/channels/whatsapp/adapter';
import { EvolutionClient } from '@/channels/whatsapp/evolution-client';
import { type Config, loadConfig } from '@/config';
import { ProfileWatcher } from '@/profile/watcher';
import { ScheduledDispatcher } from '@/scheduler/dispatcher';
import { createScheduledMessagesMcpServer } from '@/scheduler/tools';
import { createHabitsMcpServer } from '@/skills/habits/tools';
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

function buildBackend(
  config: Config,
  scheduledMcp: ReturnType<typeof createScheduledMessagesMcpServer> | null,
  habitsMcp: ReturnType<typeof createHabitsMcpServer> | null,
): AgentBackend {
  if (config.backend === 'mock') {
    return new MockBackend(loadMockFixtures());
  }
  const mcpServers = loadMcpConfig();
  const inProcess: NonNullable<
    ConstructorParameters<typeof ClaudeCodeBackend>[0]
  >['inProcessMcpServers'] = {};
  if (scheduledMcp) inProcess['scheduled-messages'] = scheduledMcp;
  if (habitsMcp) inProcess['habits'] = habitsMcp;
  return new ClaudeCodeBackend({
    mcpServers,
    inProcessMcpServers: inProcess,
  });
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
  const scheduledMessages = new ScheduledMessageRepo(db);
  const habits = new HabitRepo(db);
  const habitLogs = new HabitLogRepo(db);

  // Resolve owner chatId pra passar ao scheduler (Telegram-only na v1).
  const ownerChatId =
    config.telegram.enabled && config.telegram.ownerChatId !== null
      ? `tg:${config.telegram.ownerChatId}`
      : null;

  const scheduledMcp = ownerChatId
    ? createScheduledMessagesMcpServer({
        repo: scheduledMessages,
        ownerChatId,
      })
    : null;

  const habitsMcp = createHabitsMcpServer({
    habits,
    logs: habitLogs,
    timezone: 'America/Sao_Paulo',
    dashboardPath: join(config.workspaceDir, 'habits', 'dashboard.md'),
  });
  bootLogger.info({ event: 'mcp_inprocess_registered', name: 'habits' });

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

  const backend = buildBackend(config, scheduledMcp, habitsMcp);
  bootLogger.info({ event: 'backend_selected', backend: backend.name });

  const core = new AgentCore({
    backend,
    workspaceDir: config.workspaceDir,
    getSystemPrompt: () => promptHolder.value,
    sessions,
    sessionIdleMs: config.sessionIdleHours * 3_600_000,
  });

  const channels: Channel[] = [];
  let whatsappChannel: WhatsAppChannel | null = null;
  let evolutionClientForHealth: EvolutionClient | null = null;

  // --- Telegram channel ---
  if (config.telegram.enabled && config.telegram.botToken && config.telegram.ownerChatId !== null) {
    const telegram = new TelegramChannel({
      token: config.telegram.botToken,
      ownerChatId: config.telegram.ownerChatId,
    });

    // Audit outbound messages.
    const originalSend = telegram.send.bind(telegram);
    telegram.send = async (target, text) => {
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

    const handle = core.bind(telegram);
    await telegram.start(async (msg) => {
      messages.insert({
        chatId: msg.conversationId,
        direction: 'in',
        text: msg.text,
        correlationId: msg.correlationId,
        messageRef: msg.messageRef,
        at: Date.now(),
      });
      await handle(msg);
    });

    channels.push(telegram);
  }

  // --- WhatsApp channel ---
  if (
    config.whatsapp.enabled &&
    config.evolution.baseUrl &&
    config.evolution.apiKey &&
    config.whatsapp.ownerNumber
  ) {
    const evolutionClient = new EvolutionClient({
      baseUrl: config.evolution.baseUrl,
      apiKey: config.evolution.apiKey,
      instance: config.evolution.instance,
    });
    const evolutionOk = await evolutionClient.ping();
    if (evolutionOk) bootLogger.info({ event: 'evolution_health_ok' });
    else bootLogger.warn({ event: 'evolution_health_failed' }, 'evolution not reachable at boot');

    const whatsapp = new WhatsAppChannel({ client: evolutionClient });
    const originalSend = whatsapp.send.bind(whatsapp);
    whatsapp.send = async (target, text) => {
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

    const handle = core.bind(whatsapp);
    await whatsapp.start(async (msg) => {
      messages.insert({
        chatId: msg.conversationId,
        direction: 'in',
        text: msg.text,
        correlationId: msg.correlationId,
        messageRef: msg.messageRef,
        at: Date.now(),
      });
      await handle(msg);
    });

    channels.push(whatsapp);
    whatsappChannel = whatsapp;
    evolutionClientForHealth = evolutionClient;
  }

  if (channels.length === 0) {
    throw new Error(
      'Nenhum canal habilitado: setar TELEGRAM_ENABLED=true ou WHATSAPP_ENABLED=true em profile/.env',
    );
  }

  // Scheduler subsystem — só ativa se houver chat owner resolvido
  let dispatcher: ScheduledDispatcher | null = null;
  if (ownerChatId) {
    dispatcher = new ScheduledDispatcher({
      repo: scheduledMessages,
      channels,
      agentCore: core,
      ownerChatId,
      catchUpWindowMs: 24 * 3_600_000,
      tickMs: 60_000,
      logger: bootLogger,
    });
    await dispatcher.start();
  } else {
    bootLogger.info(
      { event: 'scheduler_disabled', reason: 'no_owner_chat' },
      'scheduler not started — no telegram owner configured',
    );
  }

  // Webhook server (precisa do Hono mesmo com WhatsApp dormante — /health é universal).
  const app = buildWebhookApp({
    ownerNumber: config.whatsapp.ownerNumber ?? '',
    expectedApiKey:
      config.webhookRequireApiKey && config.evolution.apiKey ? config.evolution.apiKey : null,
    onMessage: async (msg) => {
      // Webhook é WhatsApp-only. Se WhatsApp dormente, no-op.
      if (whatsappChannel) await whatsappChannel.dispatch(msg);
    },
    healthCheck: async () => ({
      dbOpen: true,
      channels: {
        telegram: { enabled: config.telegram.enabled },
        whatsapp: {
          enabled: config.whatsapp.enabled,
          ping: evolutionClientForHealth ? await evolutionClientForHealth.ping() : false,
        },
      },
    }),
    isOwnMessage: (id) => whatsappChannel?.isOwnMessage(id) ?? false,
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

  bootLogger.info(
    { event: 'whis_online', activeChannels: channels.map((c) => c.name) },
    'Whis online',
  );

  const shutdown = async (signal: string): Promise<void> => {
    bootLogger.info({ event: 'shutdown', signal });
    try {
      watcher.stop();
    } catch {
      /* best effort */
    }
    if (dispatcher) {
      try {
        await dispatcher.stop();
      } catch {
        /* best effort */
      }
    }
    for (const ch of channels) {
      try {
        await ch.stop();
      } catch {
        /* best effort */
      }
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
