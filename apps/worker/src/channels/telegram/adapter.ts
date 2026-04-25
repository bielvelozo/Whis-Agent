// apps/worker/src/channels/telegram/adapter.ts
import { createLogger } from '@whis/logger';
import { Bot, type Context } from 'grammy';
import type {
  Channel,
  IncomingMessage,
  MessageHandler,
  MessageTarget,
  ReactionEvent,
} from '@/channels/types';
import { toTelegramMarkdownV2 } from '@/channels/telegram/format';
import { normalizeTelegramUpdate } from '@/channels/telegram/normalize';

const logger = createLogger({ service: 'worker' });

const REACTION_EMOJI: Record<string, string> = {
  eyes: '👀',
  white_check_mark: '✅',
  warning: '⚠️',
};

export interface TelegramChannelOptions {
  /** Bot token from BotFather. Required when not using makeBot. */
  token?: string;
  /** Owner chat_id from telegram:setup helper. */
  ownerChatId: number;
  /** Test seam: returns a pre-built Bot instance (real or mock). */
  makeBot?: (token: string) => Bot;
}

export class TelegramChannel implements Channel {
  readonly name = 'telegram';
  private bot: Bot;
  private handler: MessageHandler | null = null;

  constructor(private readonly opts: TelegramChannelOptions) {
    if (opts.makeBot) {
      this.bot = opts.makeBot(opts.token ?? '');
    } else if (opts.token) {
      this.bot = new Bot(opts.token);
    } else {
      throw new Error('TelegramChannel requires `token` or `makeBot`');
    }
  }

  async start(onMessage: MessageHandler): Promise<void> {
    this.handler = onMessage;

    // Healthcheck antes do polling — pega token inválido logo.
    try {
      const me = await this.bot.api.getMe();
      logger.info(
        { event: 'telegram_health_ok', botUsername: me.username, botId: me.id },
        'telegram reachable',
      );
    } catch (err) {
      logger.warn(
        { event: 'telegram_health_failed', err: String(err) },
        'telegram getMe failed',
      );
      // Não joga — segue tentando via polling.
    }

    this.bot.on('message:text', async (ctx: Context) => {
      const update = ctx.update;
      const msg = normalizeTelegramUpdate(update, this.opts.ownerChatId);
      if (!msg) {
        logger.info(
          { event: 'dm_ignored_non_owner', channel: 'telegram', chatId: ctx.chat?.id },
          'telegram message ignored (not owner or not private)',
        );
        return;
      }
      if (this.handler) {
        await this.handler(msg);
      }
    });

    this.bot.catch((err) => {
      logger.error(
        { event: 'telegram_polling_error', err: String(err.error ?? err) },
        'grammy bot error',
      );
    });

    // Long-polling em background. Promise nunca resolve até bot.stop() — fire-and-forget é o padrão (validado em discovery).
    void this.bot.start();
  }

  async send(target: MessageTarget, text: string): Promise<{ messageRef: string }> {
    if (target.platform !== 'telegram') {
      throw new Error(`Unsupported platform: ${target.platform}`);
    }
    const formatted = toTelegramMarkdownV2(text);
    const result = await this.bot.api.sendMessage(target.conversationId, formatted, {
      parse_mode: 'MarkdownV2',
    });
    return { messageRef: String(result.message_id) };
  }

  async react(target: MessageTarget, emojiName: string): Promise<void> {
    if (!target.messageRef) return;
    const emoji = REACTION_EMOJI[emojiName];
    if (!emoji) {
      logger.warn(
        { event: 'unknown_reaction_name', channel: 'telegram', emojiName },
        'unknown reaction name',
      );
      return;
    }
    await this.bot.api.setMessageReaction(target.conversationId, Number(target.messageRef), {
      reaction: [{ type: 'emoji', emoji }],
    });
  }

  async unreact(target: MessageTarget, _emojiName: string): Promise<void> {
    if (!target.messageRef) return;
    await this.bot.api.setMessageReaction(target.conversationId, Number(target.messageRef), {
      reaction: [],
    });
  }

  async waitForReaction(
    _target: MessageTarget,
    _emojis: string[],
    _timeoutMs: number,
    _expectedUserId?: string,
  ): Promise<ReactionEvent | null> {
    return null;
  }

  async openDm(userId: string): Promise<string> {
    return userId;
  }

  async stop(): Promise<void> {
    await this.bot.stop();
    this.handler = null;
    logger.info({ event: 'telegram_channel_stopped' }, 'telegram channel stopped');
  }
}
