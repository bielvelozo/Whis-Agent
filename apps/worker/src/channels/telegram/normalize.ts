// apps/worker/src/channels/telegram/normalize.ts
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from '@/channels/types';

interface TelegramUpdate {
  update_id?: number;
  message?: {
    message_id?: number;
    chat?: {
      id?: number;
      type?: string;
    };
    from?: {
      id?: number;
      is_bot?: boolean;
    };
    text?: string;
    date?: number;
  };
}

/**
 * Converte um Update da Bot API do Telegram em IncomingMessage.
 * Filtros: só DM (chat.type === 'private'), só do owner (chat.id === ownerChatId),
 * só texto. Returns null quando o update deve ser ignorado silenciosamente.
 */
export function normalizeTelegramUpdate(
  raw: unknown,
  ownerChatId: number,
): IncomingMessage | null {
  const upd = raw as TelegramUpdate | null;
  if (!upd?.message) return null;

  const m = upd.message;
  if (!m.chat || typeof m.chat.id !== 'number') return null;
  if (m.chat.type !== 'private') return null;
  if (m.chat.id !== ownerChatId) return null;

  if (typeof m.message_id !== 'number') return null;
  if (!m.text || typeof m.text !== 'string' || m.text.trim().length === 0) return null;

  return {
    platform: 'telegram',
    userId: `tg:${m.chat.id}`,
    conversationId: `tg:${m.chat.id}`,
    threadId: null,
    text: m.text,
    correlationId: randomUUID(),
    messageRef: String(m.message_id),
    raw,
  };
}
