// apps/worker/src/agent/core.ts
import { createLogger } from '@whis/logger';
import type { SessionRepo } from '@whis/storage';
import { type AgentBackend, AgentBackendError, type AgentInput } from '@/agent/types';
import type { Channel, IncomingMessage, MessageTarget } from '@/channels/types';

const logger = createLogger({ service: 'worker' });

interface AgentCoreOptions {
  backend: AgentBackend;
  workspaceDir: string;
  /** Returns the current system prompt. Called per turn so profile/ hot-reload takes effect on new sessions. */
  getSystemPrompt: () => string;
  /** Persistent store mapping chatIds to SDK session IDs. */
  sessions: SessionRepo;
  /** Idle window: novo session após esse intervalo sem mensagem (ms). */
  sessionIdleMs: number;
}

export class AgentCore {
  constructor(private readonly opts: AgentCoreOptions) {}

  private async reportFailure(
    channel: Channel,
    target: MessageTarget,
    correlationId: string,
    error: unknown,
  ): Promise<void> {
    const reply = translateError(error);
    await channel.send(target, reply);
    await safe(() => channel.unreact(target, 'eyes'));
    logger.error(
      { event: 'handler_failed', correlationId, err: String(error) },
      'core handler failed',
    );
  }

  bind(channel: Channel): (msg: IncomingMessage) => Promise<void> {
    return async (message: IncomingMessage) => {
      const target: MessageTarget = {
        platform: message.platform,
        conversationId: message.conversationId,
        threadId: message.threadId,
        messageRef: message.messageRef,
      };

      await safe(() => channel.react(target, 'eyes'));

      const chatId = message.conversationId;
      const existing = this.opts.sessions.get(chatId);
      const idleMs = this.opts.sessionIdleMs;
      const resumeSessionId =
        existing && Date.now() - existing.lastMessageAt < idleMs ? existing.sessionId : undefined;

      const agentInput: AgentInput = {
        systemPrompt: this.opts.getSystemPrompt(),
        userMessage: wrapWithWhatsAppContext(message),
        cwd: this.opts.workspaceDir,
        correlationId: message.correlationId,
        resumeSessionId,
      };

      if (resumeSessionId) {
        logger.info(
          {
            event: 'session_resumed',
            correlationId: message.correlationId,
            chatId,
            sessionId: resumeSessionId,
          },
          'resuming session',
        );
      }

      try {
        const output = await this.opts.backend.query(agentInput);

        await channel.send(target, output.text);
        await safe(() => channel.unreact(target, 'eyes'));

        if (output.sessionId) {
          const wasNew = existing === null;
          this.opts.sessions.upsert(chatId, output.sessionId, Date.now());
          if (wasNew) {
            logger.info(
              {
                event: 'session_created',
                correlationId: message.correlationId,
                chatId,
                sessionId: output.sessionId,
              },
              'session created',
            );
          }
        }

        logger.info(
          { event: 'response_sent', correlationId: message.correlationId },
          'response sent',
        );
      } catch (firstError) {
        if (resumeSessionId && isResumeFailure(firstError)) {
          this.opts.sessions.delete(chatId);
          logger.warn(
            {
              event: 'session_resume_failed',
              correlationId: message.correlationId,
              chatId,
              staleSessionId: resumeSessionId,
            },
            'stale session, starting fresh',
          );
          try {
            const retryOutput = await this.opts.backend.query({
              ...agentInput,
              resumeSessionId: undefined,
            });
            await channel.send(target, retryOutput.text);
            await safe(() => channel.unreact(target, 'eyes'));
            if (retryOutput.sessionId) {
              this.opts.sessions.upsert(chatId, retryOutput.sessionId, Date.now());
            }
            return;
          } catch (retryError) {
            await this.reportFailure(channel, target, message.correlationId, retryError);
            return;
          }
        }

        await this.reportFailure(channel, target, message.correlationId, firstError);
      }
    };
  }
}

/** @internal Exported for testing. */
export function wrapWithWhatsAppContext(message: IncomingMessage): string {
  if (message.platform !== 'whatsapp') return message.text;
  const lines = [
    '[whatsapp_context]',
    `chat_id: ${message.conversationId}`,
    `user_id: ${message.userId}`,
    `current_time: ${new Date().toISOString()}`,
    '[/whatsapp_context]',
  ];

  if (message.parentText) {
    lines.push('');
    lines.push('[parent_message]');
    lines.push(message.parentText);
    lines.push('[/parent_message]');
  }

  if (message.attachments?.length) {
    lines.push('');
    lines.push('[attached_files]');
    for (const attachment of message.attachments) {
      lines.push(`- ${attachment.localPath} (${attachment.mimetype}, ${attachment.name})`);
    }
    lines.push('[/attached_files]');
    lines.push('Read the attached files before responding.');
  }

  lines.push('');
  lines.push(message.text);
  return lines.join('\n');
}

async function safe(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch {
    // swallow — non-critical reaction ops
  }
}

function isResumeFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /resume|session.*(not found|invalid|expired|missing)|no such session/i.test(error.message);
}

function translateError(error: unknown): string {
  if (error instanceof AgentBackendError) {
    switch (error.kind) {
      case 'auth_expired':
        return 'meu token Claude expirou. Roda `pnpm run docker:setup-token`, cola o novo no `profile/.env` e `pnpm run docker:up -d --force-recreate`.';
      case 'rate_limited':
        return 'bati o limite do plano Claude. Tenta daqui a pouco.';
      case 'timeout':
        return 'demorei demais pra responder. Tenta simplificar a pergunta?';
      default:
        return 'deu ruim aqui dentro. Olha os logs com `pnpm run docker:logs`.';
    }
  }
  return 'deu ruim aqui dentro. Olha os logs com `pnpm run docker:logs`.';
}
