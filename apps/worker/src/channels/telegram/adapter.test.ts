// apps/worker/src/channels/telegram/adapter.test.ts
import type { Bot } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import { TelegramChannel } from './adapter';

function buildBotMock() {
  const sendMessage = vi.fn(async () => ({ message_id: 999 }));
  const setMessageReaction = vi.fn(async () => true);
  const getMe = vi.fn(async () => ({ id: 1, username: 'whis_test_bot' }));
  const start = vi.fn(async () => undefined);
  const stop = vi.fn(async () => undefined);
  const onCalls: Array<{ event: string; handler: unknown }> = [];
  const catchCalls: Array<unknown> = [];

  const bot = {
    api: { sendMessage, setMessageReaction, getMe },
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
