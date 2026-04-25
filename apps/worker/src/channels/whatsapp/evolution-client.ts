// apps/worker/src/channels/whatsapp/evolution-client.ts
import { createLogger } from '@whis/logger';

const logger = createLogger({ service: 'worker' });

export interface EvolutionClientOptions {
  baseUrl: string;       // e.g. http://evolution-api:8080
  apiKey: string;
  instance: string;      // e.g. "whis"
}

export interface SendTextResult {
  messageRef: string;
}

export class EvolutionClient {
  constructor(private readonly opts: EvolutionClientOptions) {}

  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${this.opts.baseUrl}/`, {
        headers: { apikey: this.opts.apiKey },
      });
      return res.ok;
    } catch (err) {
      logger.warn({ event: 'evolution_ping_failed', err: String(err) }, 'evolution ping failed');
      return false;
    }
  }

  async sendText(number: string, text: string): Promise<SendTextResult> {
    const url = `${this.opts.baseUrl}/message/sendText/${this.opts.instance}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: this.opts.apiKey,
      },
      body: JSON.stringify({ number, text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`evolution sendText failed: ${res.status} ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as { key?: { id?: string } };
    return { messageRef: data.key?.id ?? '' };
  }

  async sendReaction(remoteJid: string, messageRef: string, emoji: string, fromMe: boolean): Promise<void> {
    const url = `${this.opts.baseUrl}/chat/sendReaction/${this.opts.instance}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: this.opts.apiKey,
      },
      body: JSON.stringify({
        reactionMessage: {
          key: { remoteJid, fromMe, id: messageRef },
          reaction: emoji,
        },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`evolution sendReaction failed: ${res.status} ${body.slice(0, 200)}`);
    }
  }

  /** Removes the previously-sent reaction by sending an empty reaction string. */
  async removeReaction(remoteJid: string, messageRef: string, fromMe: boolean): Promise<void> {
    return this.sendReaction(remoteJid, messageRef, '', fromMe);
  }
}
