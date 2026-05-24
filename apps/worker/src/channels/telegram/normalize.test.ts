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

  it('returns null when message has no text (e.g., sticker without caption)', () => {
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

  it('accepts photo message without caption (text becomes "")', () => {
    const upd = validUpdate({
      text: undefined,
      photo: [{ file_id: 'f', file_unique_id: 'u', width: 100, height: 100, file_size: 5000 }],
    });
    const msg = normalizeTelegramUpdate(upd, ownerChatId);
    expect(msg).not.toBeNull();
    expect(msg?.text).toBe('');
    expect(msg?.messageRef).toBe('42');
  });

  it('uses caption as text when photo has caption', () => {
    const upd = validUpdate({
      text: undefined,
      caption: 'olha que foto',
      photo: [{ file_id: 'f', file_unique_id: 'u', width: 100, height: 100, file_size: 5000 }],
    });
    expect(normalizeTelegramUpdate(upd, ownerChatId)?.text).toBe('olha que foto');
  });

  it('accepts voice message (always audio/ogg)', () => {
    const upd = validUpdate({
      text: undefined,
      voice: { file_id: 'v', file_unique_id: 'u', duration: 5, mime_type: 'audio/ogg' },
    });
    expect(normalizeTelegramUpdate(upd, ownerChatId)?.text).toBe('');
  });

  it('accepts audio message', () => {
    const upd = validUpdate({
      text: undefined,
      audio: { file_id: 'a', file_unique_id: 'u', duration: 30, mime_type: 'audio/mpeg' },
    });
    expect(normalizeTelegramUpdate(upd, ownerChatId)).not.toBeNull();
  });

  it('accepts PDF document', () => {
    const upd = validUpdate({
      text: undefined,
      document: { file_id: 'd', file_unique_id: 'u', mime_type: 'application/pdf' },
    });
    expect(normalizeTelegramUpdate(upd, ownerChatId)).not.toBeNull();
  });

  it('accepts image document', () => {
    const upd = validUpdate({
      text: undefined,
      document: { file_id: 'd', file_unique_id: 'u', mime_type: 'image/png' },
    });
    expect(normalizeTelegramUpdate(upd, ownerChatId)).not.toBeNull();
  });

  it('rejects unsupported document mimetype (e.g., zip)', () => {
    const upd = validUpdate({
      text: undefined,
      document: { file_id: 'd', file_unique_id: 'u', mime_type: 'application/zip' },
    });
    expect(normalizeTelegramUpdate(upd, ownerChatId)).toBeNull();
  });

  it('rejects video (unsupported)', () => {
    const upd = validUpdate({
      text: undefined,
      video: { file_id: 'v', file_unique_id: 'u', duration: 5, mime_type: 'video/mp4' },
    });
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
