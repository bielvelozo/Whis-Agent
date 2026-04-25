import { createLogger } from '@whis/logger';
import type { AgentBackend, AgentInput, AgentOutput } from '@/agent/types';

const logger = createLogger({ service: 'worker' });

export interface Fixture {
  /** RegExp tested against the (slack-context-stripped) user message. First match wins. */
  match: RegExp;
  /** Reply text returned verbatim when the pattern matches. */
  reply: string;
}

/**
 * In-memory backend that returns canned replies. Selected via ZENO_BACKEND=mock.
 * Free, instant, deterministic — useful for dev iteration on Slack/core/runner without burning Claude.
 */
export class MockBackend implements AgentBackend {
  readonly name = 'mock';
  private counter = 0;

  constructor(private readonly fixtures: Fixture[] = []) {}

  query(input: AgentInput): Promise<AgentOutput> {
    const userMessage = stripChannelContext(input.userMessage);
    const matched = this.fixtures.find((f) => f.match.test(userMessage));
    const text = matched?.reply ?? defaultEcho(userMessage);
    const sessionId = input.resumeSessionId ?? `mock-sess-${++this.counter}`;
    logger.info(
      {
        event: 'mock_backend_reply',
        correlationId: input.correlationId,
        matched: matched ? matched.match.source : null,
        sessionId,
      },
      'mock backend reply',
    );
    return Promise.resolve({ text, toolCalls: [], sessionId });
  }
}

function defaultEcho(userMessage: string): string {
  const trimmed = userMessage.trim().slice(0, 200);
  return `[mock] você disse: "${trimmed}"`;
}

/**
 * AgentCore prepends a [<channel>_context]...[/<channel>_context] preamble before the user text
 * (e.g. [slack_context] in Zeno, [whatsapp_context] in Whis). Strip whichever variant for
 * human-readable matching and echoing.
 */
function stripChannelContext(userMessage: string): string {
  return userMessage
    .replace(/^\[(slack|whatsapp)_context\][\s\S]*?\[\/(slack|whatsapp)_context\]\s*/m, '')
    .trim();
}
