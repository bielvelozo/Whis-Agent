// apps/worker/src/channels/telegram/normalize.test.ts
import { describe, expect, it } from 'vitest';
import { normalizeTelegramUpdate } from './normalize';

const ownerChatId = 123456789;

const validUpdate = (overrides: Record<string, unknown> = {}) => ({
  update_id: 1,
  message: {
    message_id: 42,
    chat: { id: ownerChatId, type: 'private', first_name: 'Gabriel' },
    from: { id: ownerChatId, is_bot: false, first_name: 'Gabriel' },
    date: Math.floor(Date.now() / 1000),
    text: 'oi',
    ...overrides,
  },
});

describe('normalizeTelegramUpdate', () => {
  it('returns IncomingMessage for valid DM from owner', () => {
    const msg = normalizeTelegramUpdate(validUpdate(), ownerChatId);
    expect(msg).not.toBeNull();
    expect(msg?.platform).toBe('telegram');
    expect(msg?.userId).toBe(`tg:${ownerChatId}`);
    expect(msg?.conversationId).toBe(`tg:${ownerChatId}`);
    expect(msg?.threadId).toBeNull();
    expect(msg?.text).toBe('oi');
    expect(msg?.messageRef).toBe('42');
    expect(msg?.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns null for chat fora da whitelist', () => {
    const upd = validUpdate({ chat: { id: 999, type: 'private' } });
    expect(normalizeTelegramUpdate(upd, ownerChatId)).toBeNull();
  });

  it('returns null for chat.type group', () => {
    const upd = validUpdate({ chat: { id: ownerChatId, type: 'group' } });
    expect(normalizeTelegramUpdate(upd, ownerChatId)).toBeNull();
  });

  it('returns null for chat.type supergroup', () => {
    const upd = validUpdate({ chat: { id: ownerChatId, type: 'supergroup' } });
    expect(normalizeTelegramUpdate(upd, ownerChatId)).toBeNull();
  });

  it('returns null when message has no text (e.g., sticker)', () => {
    const upd = {
      update_id: 1,
      message: {
        message_id: 1,
        chat: { id: ownerChatId, type: 'private' },
        from: { id: ownerChatId, is_bot: false, first_name: 'X' },
        date: 0,
      },
    };
    expect(normalizeTelegramUpdate(upd, ownerChatId)).toBeNull();
  });

  it('returns null when text is empty string', () => {
    expect(normalizeTelegramUpdate(validUpdate({ text: '' }), ownerChatId)).toBeNull();
  });

  it('returns null when text is whitespace only', () => {
    expect(normalizeTelegramUpdate(validUpdate({ text: '   \n  ' }), ownerChatId)).toBeNull();
  });

  it('returns null for non-message updates (callback_query, etc)', () => {
    expect(normalizeTelegramUpdate({ update_id: 1, callback_query: {} }, ownerChatId)).toBeNull();
  });

  it('returns null for malformed input (null, empty, missing message)', () => {
    expect(normalizeTelegramUpdate(null, ownerChatId)).toBeNull();
    expect(normalizeTelegramUpdate({}, ownerChatId)).toBeNull();
    expect(normalizeTelegramUpdate({ update_id: 1 }, ownerChatId)).toBeNull();
  });
});
