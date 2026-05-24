// apps/worker/src/channels/telegram/normalize.ts
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from '@/channels/types';

interface TelegramMessage {
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
  caption?: string;
  date?: number;
  photo?: unknown[];
  voice?: { mime_type?: string } | unknown;
  audio?: { mime_type?: string } | unknown;
  document?: { mime_type?: string } | unknown;
}

interface TelegramUpdate {
  update_id?: number;
  message?: TelegramMessage;
}

/**
 * Converte um Update da Bot API do Telegram em IncomingMessage.
 * Filtros: só DM (chat.type === 'private'), só do owner (chat.id === ownerChatId).
 *
 * Aceita mensagens de texto e mensagens com mídia suportada (foto, voice,
 * audio, document image/pdf). Para mídia, usa `caption` como texto, ou string
 * vazia se não houver caption — o adapter anexa os files baixados depois.
 * Retorna null quando o update deve ser ignorado silenciosamente.
 */
export function normalizeTelegramUpdate(raw: unknown, ownerChatId: number): IncomingMessage | null {
  const upd = raw as TelegramUpdate | null;
  if (!upd?.message) return null;

  const m = upd.message;
  if (!m.chat || typeof m.chat.id !== 'number') return null;
  if (m.chat.type !== 'private') return null;
  if (m.chat.id !== ownerChatId) return null;
  if (typeof m.message_id !== 'number') return null;

  const text = pickText(m);
  if (text === null) return null;

  return {
    platform: 'telegram',
    userId: `tg:${m.chat.id}`,
    conversationId: `tg:${m.chat.id}`,
    threadId: null,
    text,
    correlationId: randomUUID(),
    messageRef: String(m.message_id),
    raw,
  };
}

function pickText(m: TelegramMessage): string | null {
  if (typeof m.text === 'string' && m.text.trim().length > 0) return m.text;
  if (typeof m.caption === 'string' && m.caption.trim().length > 0) return m.caption;
  if (hasSupportedMedia(m)) return '';
  return null;
}

function hasSupportedMedia(m: TelegramMessage): boolean {
  if (Array.isArray(m.photo) && m.photo.length > 0) return true;
  if (m.voice) return true;
  if (m.audio) return true;
  if (m.document) {
    const mime = (m.document as { mime_type?: string }).mime_type;
    if (typeof mime === 'string' && (mime.startsWith('image/') || mime === 'application/pdf')) {
      return true;
    }
  }
  return false;
}
