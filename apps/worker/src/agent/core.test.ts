// apps/worker/src/agent/core.test.ts

import { openDatabase, runMigrations, SessionRepo } from '@whis/storage';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel, IncomingMessage } from '@/channels/types';
import {
  AgentCore,
  wrapMessageContext,
  wrapWithTelegramContext,
  wrapWithWhatsAppContext,
} from './core';
import type { AgentBackend } from './types';
import { AgentBackendError } from './types';

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

function makeBackend(
  output: { text: string; sessionId?: string } = { text: 'eai', sessionId: 's-1' },
): AgentBackend {
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

describe('wrapMessageContext', () => {
  it('despacha pra wrapWithWhatsAppContext quando platform=whatsapp', () => {
    const out = wrapMessageContext(makeMessage({ platform: 'whatsapp' }));
    expect(out).toContain('[whatsapp_context]');
  });

  it('despacha pra wrapWithTelegramContext quando platform=telegram', () => {
    const out = wrapMessageContext(
      makeMessage({ platform: 'telegram', conversationId: 'tg:42', userId: 'tg:42', text: 'oi' }),
    );
    expect(out).toContain('[telegram_context]');
    expect(out).toContain('chat_id: tg:42');
    expect(out).toContain('oi');
  });

  it('retorna texto cru pra platform desconhecida', () => {
    const out = wrapMessageContext(makeMessage({ platform: 'mock', text: 'oi' }));
    expect(out).toBe('oi');
  });
});

describe('wrapWithTelegramContext', () => {
  it('prepends a telegram_context preamble', () => {
    const wrapped = wrapWithTelegramContext(
      makeMessage({ platform: 'telegram', conversationId: 'tg:99', userId: 'tg:99', text: 'oi' }),
    );
    expect(wrapped).toContain('[telegram_context]');
    expect(wrapped).toContain('chat_id: tg:99');
    expect(wrapped).toContain('oi');
  });

  it('includes scheduled_trigger block when present', () => {
    const wrapped = wrapWithTelegramContext(
      makeMessage({
        platform: 'telegram',
        conversationId: 'tg:99',
        userId: 'system:scheduler',
        text: 'gera bom dia',
        scheduledTrigger: { id: 12, title: 'bom-dia' },
      }),
    );
    expect(wrapped).toContain('scheduled_trigger:');
    expect(wrapped).toContain('id: 12');
    expect(wrapped).toContain('title: bom-dia');
  });

  it('omits scheduled_trigger block when absent (backward compat)', () => {
    const wrapped = wrapWithTelegramContext(
      makeMessage({ platform: 'telegram', conversationId: 'tg:99', userId: 'tg:99', text: 'oi' }),
    );
    expect(wrapped).not.toContain('scheduled_trigger');
  });
});

describe('AgentCore.dispatchSynthetic', () => {
  let sessions: SessionRepo;
  beforeEach(() => {
    const db = openDatabase(':memory:');
    runMigrations(db);
    sessions = new SessionRepo(db);
  });

  it('runs agent turn but skips react/unreact', async () => {
    const channel = makeChannel();
    const backend = makeBackend({ text: 'bom dia, agenda livre', sessionId: 'sched-sid' });
    const core = new AgentCore({
      backend,
      workspaceDir: '/app/context',
      getSystemPrompt: () => 'PROMPT',
      sessions,
      sessionIdleMs: 6 * 3_600_000,
    });

    await core.dispatchSynthetic({
      ...makeMessage({
        platform: 'telegram',
        conversationId: 'tg:1',
        userId: 'system:scheduler',
        text: 'gera bom dia',
        correlationId: 'sched-1',
        messageRef: '',
        scheduledTrigger: { id: 12, title: 'bom-dia' },
      }),
      channel,
    });

    expect(channel._send).toHaveBeenCalledWith(expect.any(Object), 'bom dia, agenda livre');
    expect(channel._react).not.toHaveBeenCalled();
    expect(channel._unreact).not.toHaveBeenCalled();
    expect(sessions.get('tg:1')?.sessionId).toBe('sched-sid');
  });

  it('throws on backend failure (no swallow — let dispatcher log)', async () => {
    const channel = makeChannel();
    const backend: AgentBackend = {
      name: 'mock',
      query: vi.fn(async () => {
        throw new AgentBackendError('rate_limited', 'limit');
      }),
    };
    const core = new AgentCore({
      backend,
      workspaceDir: '/app/context',
      getSystemPrompt: () => 'PROMPT',
      sessions,
      sessionIdleMs: 6 * 3_600_000,
    });

    await expect(
      core.dispatchSynthetic({
        ...makeMessage({
          platform: 'telegram',
          conversationId: 'tg:1',
          userId: 'system:scheduler',
          text: 'gera',
          correlationId: 'sched-2',
          messageRef: '',
        }),
        channel,
      }),
    ).rejects.toThrow();
    expect(channel._send).not.toHaveBeenCalled();
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

  it('mantém sessões isoladas entre canais com chatIds distintos', async () => {
    const wa = makeChannel();
    const tg = makeChannel();
    let turn = 0;
    const backend: AgentBackend = {
      name: 'mock',
      query: vi.fn(async () => ({ text: 'ok', toolCalls: [], sessionId: `sid-${++turn}` })),
    };

    const core = new AgentCore({
      backend,
      workspaceDir: '/app/context',
      getSystemPrompt: () => 'PROMPT',
      sessions,
      sessionIdleMs: 6 * 60 * 60 * 1000,
    });

    const handleWa = core.bind(wa);
    const handleTg = core.bind(tg);

    await handleWa(
      makeMessage({
        platform: 'whatsapp',
        userId: '5511999999999@s.whatsapp.net',
        conversationId: '5511999999999@s.whatsapp.net',
        correlationId: 'cid-wa',
        messageRef: 'mref-wa',
      }),
    );

    await handleTg(
      makeMessage({
        platform: 'telegram',
        userId: 'tg:5511999999999',
        conversationId: 'tg:5511999999999',
        correlationId: 'cid-tg',
        messageRef: '42',
      }),
    );

    const waSession = sessions.get('5511999999999@s.whatsapp.net');
    const tgSession = sessions.get('tg:5511999999999');
    expect(waSession?.sessionId).toBe('sid-1');
    expect(tgSession?.sessionId).toBe('sid-2');
    expect(waSession?.sessionId).not.toBe(tgSession?.sessionId);
  });
});
