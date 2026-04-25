// apps/worker/src/channels/whatsapp/adapter.ts
import { createLogger } from '@whis/logger';
import type {
  Channel,
  IncomingMessage,
  MessageHandler,
  MessageTarget,
  ReactionEvent,
} from '@/channels/types';
import type { EvolutionClient } from '@/channels/whatsapp/evolution-client';
import { toWhatsAppText } from '@/channels/whatsapp/format';

const logger = createLogger({ service: 'worker' });

/** Mapping de nomes simbólicos (slack-style) pra emojis WhatsApp. */
const REACTION_EMOJI: Record<string, string> = {
  eyes: '👀',
  white_check_mark: '✅',
  warning: '⚠️',
};

export interface WhatsAppChannelOptions {
  client: EvolutionClient;
}

/**
 * Bound do set de IDs recentes que o próprio Whis enviou. Usado no modo
 * single-number pra distinguir "user mandou pro próprio número" (fromMe=true,
 * id desconhecido) de "Whis respondeu" (fromMe=true, id que acabamos de
 * emitir). Set evicta a metade mais antiga ao bater o teto.
 */
const MAX_OWN_MESSAGE_IDS = 500;

export class WhatsAppChannel implements Channel {
  readonly name = 'whatsapp';
  private handler: MessageHandler | null = null;
  private readonly recentOwnMessageIds = new Set<string>();

  constructor(private readonly opts: WhatsAppChannelOptions) {}

  /** Returns true se `id` está na janela recente de mensagens emitidas pelo próprio Whis. */
  isOwnMessage(id: string): boolean {
    return id ? this.recentOwnMessageIds.has(id) : false;
  }

  private trackOwnMessage(id: string): void {
    if (!id) return;
    if (this.recentOwnMessageIds.size >= MAX_OWN_MESSAGE_IDS) {
      const target = Math.floor(MAX_OWN_MESSAGE_IDS / 2);
      let dropped = 0;
      for (const k of this.recentOwnMessageIds) {
        this.recentOwnMessageIds.delete(k);
        if (++dropped >= target) break;
      }
    }
    this.recentOwnMessageIds.add(id);
  }

  async start(onMessage: MessageHandler): Promise<void> {
    this.handler = onMessage;
    const ok = await this.opts.client.ping();
    if (!ok) {
      logger.warn({ event: 'evolution_offline_at_boot' }, 'evolution unreachable at boot');
    } else {
      logger.info({ event: 'evolution_health_ok' }, 'evolution reachable');
    }
  }

  /** Called by the webhook server after normalize succeeds. */
  async dispatch(message: IncomingMessage): Promise<void> {
    if (!this.handler) {
      logger.warn(
        { event: 'dispatch_no_handler', correlationId: message.correlationId },
        'dispatch called before start()',
      );
      return;
    }
    try {
      await this.handler(message);
    } catch (error) {
      logger.error(
        { event: 'handler_error', correlationId: message.correlationId, err: String(error) },
        'handler threw',
      );
    }
  }

  async send(target: MessageTarget, text: string): Promise<{ messageRef: string }> {
    if (target.platform !== 'whatsapp') {
      throw new Error(`Unsupported platform: ${target.platform}`);
    }
    const formatted = toWhatsAppText(text);
    const result = await this.opts.client.sendText(target.conversationId, formatted);
    this.trackOwnMessage(result.messageRef);
    return result;
  }

  async react(target: MessageTarget, emojiName: string): Promise<void> {
    if (!target.messageRef) return;
    const emoji = REACTION_EMOJI[emojiName];
    if (!emoji) {
      logger.warn({ event: 'unknown_reaction_name', emojiName }, 'unknown reaction name');
      return;
    }
    await this.opts.client.sendReaction(target.conversationId, target.messageRef, emoji, false);
  }

  async unreact(target: MessageTarget, _emojiName: string): Promise<void> {
    if (!target.messageRef) return;
    await this.opts.client.removeReaction(target.conversationId, target.messageRef, false);
  }

  async waitForReaction(
    _target: MessageTarget,
    _emojis: string[],
    _timeoutMs: number,
    _expectedUserId?: string,
  ): Promise<ReactionEvent | null> {
    // No-op no MVP: usado só por guardrails (fora de escopo).
    return null;
  }

  async openDm(userId: string): Promise<string> {
    // No WhatsApp DM, conversationId = userId (jid).
    return userId;
  }

  async stop(): Promise<void> {
    this.handler = null;
    logger.info({ event: 'whatsapp_channel_stopped' }, 'whatsapp channel stopped');
  }
}
