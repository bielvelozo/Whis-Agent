// apps/worker/src/agent/core.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AgentCore, wrapWithWhatsAppContext } from './core';
import type { AgentBackend } from './types';
import { AgentBackendError } from './types';
import type { Channel, IncomingMessage } from '@/channels/types';
import { openDatabase, runMigrations, SessionRepo } from '@whis/storage';

function makeMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    platform: 'whatsapp',
    userId: '5511999999999@s.whatsapp.net',
    conversationId: '5511999999999@s.whatsapp.net',
    threadId: null,
    text: 'oi',
    correlationId: 'cid-1',
    messageRef: 'mref-1',
    raw: {},
    ...overrides,
  };
}

function makeChannel() {
  const send = vi.fn(async () => ({ messageRef: 'reply-ref' }));
  const react = vi.fn(async () => undefined);
  const unreact = vi.fn(async () => undefined);
  return {
    name: 'whatsapp',
    start: vi.fn(),
    send,
    react,
    unreact,
    waitForReaction: vi.fn(async () => null),
    openDm: vi.fn(async (id: string) => id),
    stop: vi.fn(),
    _send: send,
    _react: react,
    _unreact: unreact,
  } as unknown as Channel & { _send: typeof send; _react: typeof react; _unreact: typeof unreact };
}

function makeBackend(output: { text: string; sessionId?: string } = { text: 'eai', sessionId: 's-1' }): AgentBackend {
  return {
    name: 'mock',
    query: vi.fn(async () => ({ ...output, toolCalls: [] })),
  };
}

describe('wrapWithWhatsAppContext', () => {
  it('prepends a whatsapp_context preamble', () => {
    const wrapped = wrapWithWhatsAppContext(makeMessage({ text: 'hello' }));
    expect(wrapped).toContain('[whatsapp_context]');
    expect(wrapped).toContain('chat_id: 5511999999999@s.whatsapp.net');
    expect(wrapped).toContain('hello');
  });
});

describe('AgentCore', () => {
  let sessions: SessionRepo;
  beforeEach(() => {
    const db = openDatabase(':memory:');
    runMigrations(db);
    sessions = new SessionRepo(db);
  });

  it('reacts on entry, sends reply, unreacts at end (no extra reactions)', async () => {
    const channel = makeChannel();
    const backend = makeBackend({ text: 'opa', sessionId: 's-1' });
    const core = new AgentCore({
      backend,
      workspaceDir: '/app/context',
      getSystemPrompt: () => 'PROMPT',
      sessions,
      sessionIdleMs: 6 * 60 * 60 * 1000,
    });
    const handler = core.bind(channel);

    await handler(makeMessage());

    expect(channel._react).toHaveBeenCalledWith(expect.any(Object), 'eyes');
    expect(channel._send).toHaveBeenCalledWith(expect.any(Object), 'opa');
    expect(channel._unreact).toHaveBeenCalledWith(expect.any(Object), 'eyes');
    // confirma que NÃO chama outras reactions (exceto a única react+unreact 'eyes')
    expect(channel._react).toHaveBeenCalledTimes(1);
  });

  it('persists the session id on success', async () => {
    const channel = makeChannel();
    const backend = makeBackend({ text: 'opa', sessionId: 'sid-A' });
    const core = new AgentCore({
      backend,
      workspaceDir: '/app/context',
      getSystemPrompt: () => 'PROMPT',
      sessions,
      sessionIdleMs: 6 * 60 * 60 * 1000,
    });
    await core.bind(channel)(makeMessage());

    const stored = sessions.get('5511999999999@s.whatsapp.net');
    expect(stored?.sessionId).toBe('sid-A');
  });

  it('starts a fresh session when last message is older than idle window', async () => {
    sessions.upsert('5511999999999@s.whatsapp.net', 'old-sid', Date.now() - 7 * 60 * 60 * 1000);
    const channel = makeChannel();
    const backend = makeBackend({ text: 'opa', sessionId: 'new-sid' });
    const core = new AgentCore({
      backend,
      workspaceDir: '/app/context',
      getSystemPrompt: () => 'PROMPT',
      sessions,
      sessionIdleMs: 6 * 60 * 60 * 1000,
    });
    await core.bind(channel)(makeMessage());

    const queryArgs = (backend.query as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(queryArgs.resumeSessionId).toBeUndefined();
    expect(sessions.get('5511999999999@s.whatsapp.net')?.sessionId).toBe('new-sid');
  });

  it('translates AgentBackendError(auth_expired) into PT-BR setup-token instructions', async () => {
    const channel = makeChannel();
    const backend: AgentBackend = {
      name: 'mock',
      query: vi.fn(async () => {
        throw new AgentBackendError('auth_expired', 'expired');
      }),
    };
    const core = new AgentCore({
      backend,
      workspaceDir: '/app/context',
      getSystemPrompt: () => 'PROMPT',
      sessions,
      sessionIdleMs: 6 * 60 * 60 * 1000,
    });
    await core.bind(channel)(makeMessage());

    expect(channel._send).toHaveBeenCalledWith(
      expect.any(Object),
      expect.stringContaining('docker:setup-token'),
    );
  });
});
