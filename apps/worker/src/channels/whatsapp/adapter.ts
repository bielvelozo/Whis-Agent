// apps/worker/src/channels/whatsapp/adapter.ts
import { createLogger } from '@whis/logger';
import { toWhatsAppText } from '@/channels/whatsapp/format';
import { EvolutionClient } from '@/channels/whatsapp/evolution-client';
import type {
  Channel,
  IncomingMessage,
  MessageHandler,
  MessageTarget,
  ReactionEvent,
} from '@/channels/types';

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

export class WhatsAppChannel implements Channel {
  readonly name = 'whatsapp';
  private handler: MessageHandler | null = null;

  constructor(private readonly opts: WhatsAppChannelOptions) {}

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
    return this.opts.client.sendText(target.conversationId, formatted);
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
