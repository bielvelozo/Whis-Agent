// apps/worker/src/channels/telegram/adapter.test.ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Bot } from 'grammy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TelegramChannel } from './adapter';

function buildBotMock() {
  const sendMessage = vi.fn(async () => ({ message_id: 999 }));
  const setMessageReaction = vi.fn(async () => true);
  const getMe = vi.fn(async () => ({ id: 1, username: 'whis_test_bot' }));
  const getFile = vi.fn(async (_id: string) => ({ file_path: 'photos/test.jpg' }));
  const start = vi.fn(async () => undefined);
  const stop = vi.fn(async () => undefined);
  const onCalls: Array<{ event: string; handler: unknown }> = [];
  const catchCalls: Array<unknown> = [];

  const bot = {
    api: { sendMessage, setMessageReaction, getMe, getFile },
    start,
    stop,
    on: (event: string, handler: unknown) => {
      onCalls.push({ event, handler });
    },
    catch: (handler: unknown) => {
      catchCalls.push(handler);
    },
  };
  return {
    bot: bot as unknown as Bot,
    sendMessage,
    setMessageReaction,
    getMe,
    getFile,
    start,
    stop,
    onCalls,
    catchCalls,
  };
}

describe('TelegramChannel', () => {
  it('start() chama getMe antes de bot.start()', async () => {
    const m = buildBotMock();
    const ch = new TelegramChannel({ ownerChatId: 1, makeBot: () => m.bot });
    const handler = vi.fn(async () => undefined);
    await ch.start(handler);
    expect(m.getMe).toHaveBeenCalledTimes(1);
    expect(m.start).toHaveBeenCalledTimes(1);
    expect(m.getMe.mock.invocationCallOrder[0]).toBeLessThan(m.start.mock.invocationCallOrder[0]);
  });

  it('send invoca sendMessage com chat_id numérico (strip do tg: keyspace) e parse_mode MarkdownV2', async () => {
    const m = buildBotMock();
    const ch = new TelegramChannel({ ownerChatId: 1, makeBot: () => m.bot });
    await ch.start(vi.fn());
    const r = await ch.send(
      { platform: 'telegram', conversationId: 'tg:42', threadId: null, messageRef: '5' },
      'hello **world**',
    );
    expect(m.sendMessage).toHaveBeenCalledWith(
      42,
      'hello *world*',
      expect.objectContaining({ parse_mode: 'MarkdownV2' }),
    );
    expect(r.messageRef).toBe('999');
  });

  it('react invoca setMessageReaction com chat_id numérico e emoji mapeado', async () => {
    const m = buildBotMock();
    const ch = new TelegramChannel({ ownerChatId: 1, makeBot: () => m.bot });
    await ch.start(vi.fn());
    await ch.react(
      { platform: 'telegram', conversationId: 'tg:42', threadId: null, messageRef: '7' },
      'eyes',
    );
    expect(m.setMessageReaction).toHaveBeenCalledWith(42, 7, [{ type: 'emoji', emoji: '👀' }]);
  });

  it('unreact invoca setMessageReaction com chat_id numérico e array vazia', async () => {
    const m = buildBotMock();
    const ch = new TelegramChannel({ ownerChatId: 1, makeBot: () => m.bot });
    await ch.start(vi.fn());
    await ch.unreact(
      { platform: 'telegram', conversationId: 'tg:42', threadId: null, messageRef: '7' },
      'eyes',
    );
    expect(m.setMessageReaction).toHaveBeenCalledWith(42, 7, []);
  });

  it('react com emoji desconhecido vira no-op', async () => {
    const m = buildBotMock();
    const ch = new TelegramChannel({ ownerChatId: 1, makeBot: () => m.bot });
    await ch.start(vi.fn());
    await ch.react(
      { platform: 'telegram', conversationId: 'tg:42', threadId: null, messageRef: '7' },
      'unknown_emoji',
    );
    expect(m.setMessageReaction).not.toHaveBeenCalled();
  });

  it('waitForReaction returns null (no-op MVP)', async () => {
    const m = buildBotMock();
    const ch = new TelegramChannel({ ownerChatId: 1, makeBot: () => m.bot });
    await ch.start(vi.fn());
    const r = await ch.waitForReaction(
      { platform: 'telegram', conversationId: 'tg:42', threadId: null },
      ['eyes'],
      1000,
    );
    expect(r).toBeNull();
  });

  it('stop chama bot.stop()', async () => {
    const m = buildBotMock();
    const ch = new TelegramChannel({ ownerChatId: 1, makeBot: () => m.bot });
    await ch.start(vi.fn());
    await ch.stop();
    expect(m.stop).toHaveBeenCalledTimes(1);
  });
});

describe('TelegramChannel — media ingest', () => {
  let inboxDir: string;

  beforeEach(async () => {
    inboxDir = await mkdtemp(join(tmpdir(), 'whis-adapter-media-'));
  });

  afterEach(async () => {
    await rm(inboxDir, { recursive: true, force: true });
  });

  it('photo message → handler recebe IncomingMessage com attachments populadas', async () => {
    const m = buildBotMock();
    const fetcher = vi.fn(
      async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }),
    ) as unknown as typeof fetch;
    const ch = new TelegramChannel({
      ownerChatId: 1,
      token: 'TOK',
      makeBot: () => m.bot,
      inboxDir,
      fetcher,
    });
    const handler = vi.fn(async () => undefined);
    await ch.start(handler);

    const messageHandler = m.onCalls.find((c) => c.event === 'message')?.handler as (
      ctx: unknown,
    ) => Promise<void>;
    expect(messageHandler).toBeDefined();

    await messageHandler({
      chat: { id: 1, type: 'private' },
      update: {
        message: {
          message_id: 7,
          chat: { id: 1, type: 'private' },
          from: { id: 1, is_bot: false },
          date: 0,
          photo: [{ file_id: 'big', file_unique_id: 'u', width: 100, height: 100, file_size: 4 }],
        },
      },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    const incoming = (handler.mock.calls as unknown as unknown[][])[0][0] as {
      text: string;
      attachments?: { mimetype: string; localPath: string }[];
    };
    expect(incoming.text).toBe('');
    expect(incoming.attachments).toHaveLength(1);
    expect(incoming.attachments?.[0].mimetype).toBe('image/jpeg');
    expect(incoming.attachments?.[0].localPath.startsWith(inboxDir)).toBe(true);
    expect(m.getFile).toHaveBeenCalledWith('big');
  });

  it('mensagem de outro chat é ignorada (não chama handler nem baixa mídia)', async () => {
    const m = buildBotMock();
    const fetcher = vi.fn(
      async () => new Response('x', { status: 200 }),
    ) as unknown as typeof fetch;
    const ch = new TelegramChannel({
      ownerChatId: 1,
      token: 'TOK',
      makeBot: () => m.bot,
      inboxDir,
      fetcher,
    });
    const handler = vi.fn(async () => undefined);
    await ch.start(handler);

    const messageHandler = m.onCalls.find((c) => c.event === 'message')?.handler as (
      ctx: unknown,
    ) => Promise<void>;
    await messageHandler({
      chat: { id: 999, type: 'private' },
      update: {
        message: {
          message_id: 7,
          chat: { id: 999, type: 'private' },
          from: { id: 999, is_bot: false },
          date: 0,
          photo: [{ file_id: 'big', file_unique_id: 'u', width: 100, height: 100 }],
        },
      },
    });

    expect(handler).not.toHaveBeenCalled();
    expect(m.getFile).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('inboxDir omitido → mensagem com foto passa sem attachments (text-only mode)', async () => {
    const m = buildBotMock();
    const ch = new TelegramChannel({ ownerChatId: 1, token: 'TOK', makeBot: () => m.bot });
    const handler = vi.fn(async () => undefined);
    await ch.start(handler);

    const messageHandler = m.onCalls.find((c) => c.event === 'message')?.handler as (
      ctx: unknown,
    ) => Promise<void>;
    await messageHandler({
      chat: { id: 1, type: 'private' },
      update: {
        message: {
          message_id: 7,
          chat: { id: 1, type: 'private' },
          from: { id: 1, is_bot: false },
          date: 0,
          text: 'oi',
        },
      },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    const incoming = (handler.mock.calls as unknown as unknown[][])[0][0] as {
      attachments?: unknown;
    };
    expect(incoming.attachments).toBeUndefined();
    expect(m.getFile).not.toHaveBeenCalled();
  });
});
