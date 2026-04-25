// apps/worker/src/channels/whatsapp/normalize.test.ts
import { describe, expect, it } from 'vitest';
import { normalizeEvolutionEvent } from './normalize';

const owner = '5511999999999';

describe('normalizeEvolutionEvent', () => {
  it('returns IncomingMessage for a valid messages.upsert from owner', () => {
    const evt = {
      event: 'messages.upsert',
      data: {
        key: { remoteJid: `${owner}@s.whatsapp.net`, fromMe: false, id: 'mid-1' },
        message: { conversation: 'oi' },
      },
    };
    const msg = normalizeEvolutionEvent(evt, owner);
    expect(msg).not.toBeNull();
    expect(msg?.platform).toBe('whatsapp');
    expect(msg?.userId).toBe(`${owner}@s.whatsapp.net`);
    expect(msg?.conversationId).toBe(`${owner}@s.whatsapp.net`);
    expect(msg?.threadId).toBeNull();
    expect(msg?.text).toBe('oi');
    expect(msg?.messageRef).toBe('mid-1');
    expect(msg?.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns null when fromMe is true (echo)', () => {
    const evt = {
      event: 'messages.upsert',
      data: {
        key: { remoteJid: `${owner}@s.whatsapp.net`, fromMe: true, id: 'mid-1' },
        message: { conversation: 'oi' },
      },
    };
    expect(normalizeEvolutionEvent(evt, owner)).toBeNull();
  });

  it('returns null when sender is not the owner', () => {
    const evt = {
      event: 'messages.upsert',
      data: {
        key: { remoteJid: '5599888888888@s.whatsapp.net', fromMe: false, id: 'mid-1' },
        message: { conversation: 'oi' },
      },
    };
    expect(normalizeEvolutionEvent(evt, owner)).toBeNull();
  });

  it('returns null for non-text messages (no conversation field)', () => {
    const evt = {
      event: 'messages.upsert',
      data: {
        key: { remoteJid: `${owner}@s.whatsapp.net`, fromMe: false, id: 'mid-1' },
        message: { audioMessage: { url: '...' } },
      },
    };
    expect(normalizeEvolutionEvent(evt, owner)).toBeNull();
  });

  it('returns null for non-message events (presence, status)', () => {
    const evt = { event: 'presence.update', data: {} };
    expect(normalizeEvolutionEvent(evt, owner)).toBeNull();
  });

  it('returns null for group messages (jid contains @g.us)', () => {
    const evt = {
      event: 'messages.upsert',
      data: {
        key: { remoteJid: '120363012345678@g.us', fromMe: false, id: 'mid-1' },
        message: { conversation: 'group msg' },
      },
    };
    expect(normalizeEvolutionEvent(evt, owner)).toBeNull();
  });

  describe('single-number mode (isOwnMessage callback)', () => {
    const selfEvt = (id: string) => ({
      event: 'messages.upsert',
      data: {
        key: { remoteJid: `${owner}@s.whatsapp.net`, fromMe: true, id },
        message: { conversation: 'mensagem do dono pra si mesmo' },
      },
    });

    it('accepts fromMe: true when id is NOT in own-message tracker', () => {
      const isOwn = (_id: string) => false;
      const msg = normalizeEvolutionEvent(selfEvt('user-mid-1'), owner, isOwn);
      expect(msg).not.toBeNull();
      expect(msg?.text).toBe('mensagem do dono pra si mesmo');
      expect(msg?.messageRef).toBe('user-mid-1');
    });

    it('rejects fromMe: true when id IS in own-message tracker (Whis echo)', () => {
      const tracked = new Set(['whis-mid-42']);
      const isOwn = (id: string) => tracked.has(id);
      expect(normalizeEvolutionEvent(selfEvt('whis-mid-42'), owner, isOwn)).toBeNull();
    });

    it('still rejects fromMe: true with default callback (legacy/dual-number behavior)', () => {
      // Sem callback, todo fromMe: true é tratado como echo do próprio Whis.
      expect(normalizeEvolutionEvent(selfEvt('any-id'), owner)).toBeNull();
    });
  });
});
