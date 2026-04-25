// apps/worker/src/channels/whatsapp/normalize.ts
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from '@/channels/types';

/**
 * Schema esperado (subset) do evento `messages.upsert` da Evolution API.
 * Validamos defensivamente — campos faltantes retornam null.
 */
interface EvolutionEvent {
  event?: string;
  data?: {
    key?: {
      remoteJid?: string;
      fromMe?: boolean;
      id?: string;
    };
    message?: {
      conversation?: string;
      extendedTextMessage?: { text?: string };
    };
  };
}

/**
 * Converts an Evolution `messages.upsert` event into an IncomingMessage.
 * Filters: only owner sender, only DMs (no @g.us), only text, only fromMe=false.
 * Returns null when the event should be silently ignored.
 */
export function normalizeEvolutionEvent(raw: unknown, ownerNumber: string): IncomingMessage | null {
  const evt = raw as EvolutionEvent;

  if (evt?.event !== 'messages.upsert') return null;
  const data = evt.data;
  if (!data?.key || !data.message) return null;
  if (data.key.fromMe === true) return null;

  const remoteJid = data.key.remoteJid;
  if (!remoteJid) return null;
  if (remoteJid.endsWith('@g.us')) return null; // grupos não suportados no MVP

  // Whitelist: jid deve começar com `<ownerNumber>@`
  if (!remoteJid.startsWith(`${ownerNumber}@`)) return null;

  const text = data.message.conversation ?? data.message.extendedTextMessage?.text;
  if (!text || typeof text !== 'string' || text.trim().length === 0) return null;

  return {
    platform: 'whatsapp',
    userId: remoteJid,
    conversationId: remoteJid,
    threadId: null,
    text,
    correlationId: randomUUID(),
    messageRef: data.key.id ?? '',
    raw,
  };
}
