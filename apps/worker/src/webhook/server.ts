// apps/worker/src/webhook/server.ts

import { createLogger } from '@whis/logger';
import { Hono } from 'hono';
import type { IncomingMessage } from '@/channels/types';
import { normalizeEvolutionEvent } from '@/channels/whatsapp/normalize';

const logger = createLogger({ service: 'worker' });

export interface ChannelHealth {
  enabled: boolean;
  /** Optional liveness ping (only present pra canais que suportam). */
  ping?: boolean;
}

export interface WebhookDeps {
  ownerNumber: string;
  /** Optional API key check. When set, requests without this `apikey` header are 401. Pass null/empty to disable. */
  expectedApiKey: string | null;
  onMessage: (msg: IncomingMessage) => Promise<void>;
  healthCheck: () => Promise<{ dbOpen: boolean; channels: Record<string, ChannelHealth> }>;
  /**
   * Returns true se o `key.id` veio de uma mensagem que o próprio Whis
   * emitiu recentemente. Usado pra desambiguar `fromMe: true` no modo
   * single-number. Quando ausente, todo `fromMe: true` é descartado.
   */
  isOwnMessage?: (id: string) => boolean;
}

export function buildWebhookApp(deps: WebhookDeps): Hono {
  const app = new Hono();

  app.get('/health', async (c) => {
    const h = await deps.healthCheck();
    const status = h.dbOpen ? 'ok' : 'degraded';
    return c.json(
      { status, dbOpen: h.dbOpen, channels: h.channels, uptime: process.uptime() },
      h.dbOpen ? 200 : 503,
    );
  });

  app.post('/webhook/whatsapp', async (c) => {
    if (deps.expectedApiKey) {
      const got = c.req.header('apikey');
      if (got !== deps.expectedApiKey) {
        logger.warn({ event: 'webhook_unauthorized' }, 'webhook unauthorized');
        return c.json({ error: 'unauthorized' }, 401);
      }
    }

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      logger.warn({ event: 'webhook_invalid_payload' }, 'webhook payload not JSON');
      return c.json({ error: 'invalid_payload' }, 400);
    }

    const msg = normalizeEvolutionEvent(raw, deps.ownerNumber, deps.isOwnMessage);
    if (!msg) {
      return c.json({ ignored: true });
    }

    logger.info(
      { event: 'message_received', userId: msg.userId, correlationId: msg.correlationId },
      'whatsapp message received',
    );

    // Dispatch async — Evolution só precisa do 200 rápido.
    deps.onMessage(msg).catch((err) => {
      logger.error(
        { event: 'on_message_failed', correlationId: msg.correlationId, err: String(err) },
        'onMessage threw',
      );
    });

    return c.json({ accepted: true });
  });

  return app;
}
