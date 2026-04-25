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
 * Filters: only owner sender, only DMs (no @g.us), only text.
 * Returns null when the event should be silently ignored.
 *
 * Eventos com `fromMe: true` (originados pelo número pareado) são aceitos
 * apenas se o `key.id` NÃO estiver na janela recente de mensagens emitidas
 * pelo próprio Whis (`isOwnMessage`). Isso habilita modo single-number:
 * usuário pareia o próprio número e conversa via "Mensagem enviada a mim
 * mesmo"; o tracker evita loop infinito de Whis respondendo às próprias
 * respostas. Se `isOwnMessage` não for fornecido, o comportamento legado
 * (rejeitar todo `fromMe: true`) é preservado.
 */
export function normalizeEvolutionEvent(
  raw: unknown,
  ownerNumber: string,
  isOwnMessage: (id: string) => boolean = () => true,
): IncomingMessage | null {
  const evt = raw as EvolutionEvent;

  if (evt?.event !== 'messages.upsert') return null;
  const data = evt.data;
  if (!data?.key || !data.message) return null;

  if (data.key.fromMe === true) {
    // Sem callback, ou ID bate com algo que o Whis emitiu → ignora.
    if (isOwnMessage(data.key.id ?? '')) return null;
    // Caso contrário, é mensagem do dono pra si mesmo (single-number) — segue.
  }

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
