// apps/worker/src/webhook/server.test.ts
import { describe, it, expect, vi } from 'vitest';
import type { IncomingMessage } from '@/channels/types';
import { buildWebhookApp, type WebhookDeps } from './server';

const makeOnMessage = (): WebhookDeps['onMessage'] =>
  vi.fn(async (_msg: IncomingMessage): Promise<void> => undefined);

function makeDeps(overrides: Partial<WebhookDeps> = {}): WebhookDeps {
  return {
    ownerNumber: '5511999999999',
    expectedApiKey: 'secret',
    onMessage: makeOnMessage(),
    healthCheck: vi.fn(async () => ({ dbOpen: true, evolutionPing: true })),
    ...overrides,
  };
}

const validEvent = {
  event: 'messages.upsert',
  data: {
    key: { remoteJid: '5511999999999@s.whatsapp.net', fromMe: false, id: 'mid-1' },
    message: { conversation: 'oi' },
  },
};

describe('webhook app', () => {
  it('GET /health returns 200 with status payload', async () => {
    const app = buildWebhookApp(makeDeps());
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: 'ok', dbOpen: true, evolutionPing: true });
  });

  it('POST /webhook/whatsapp 401 when apikey missing', async () => {
    const app = buildWebhookApp(makeDeps());
    const res = await app.request('/webhook/whatsapp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validEvent),
    });
    expect(res.status).toBe(401);
  });

  it('POST /webhook/whatsapp 400 on malformed JSON', async () => {
    const app = buildWebhookApp(makeDeps());
    const res = await app.request('/webhook/whatsapp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: 'secret' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });

  it('POST /webhook/whatsapp 200 dispatches a normalized message', async () => {
    const onMessage = makeOnMessage();
    const app = buildWebhookApp(makeDeps({ onMessage }));
    const res = await app.request('/webhook/whatsapp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: 'secret' },
      body: JSON.stringify(validEvent),
    });
    expect(res.status).toBe(200);
    expect(onMessage).toHaveBeenCalledOnce();
    const calls = (onMessage as unknown as { mock: { calls: [IncomingMessage][] } }).mock.calls;
    const arg = calls[0]?.[0];
    expect(arg?.text).toBe('oi');
    expect(arg?.platform).toBe('whatsapp');
  });

  it('POST /webhook/whatsapp 200 with `ignored: true` when normalize returns null', async () => {
    const onMessage = makeOnMessage();
    const app = buildWebhookApp(makeDeps({ onMessage }));
    const res = await app.request('/webhook/whatsapp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: 'secret' },
      body: JSON.stringify({ event: 'presence.update', data: {} }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ignored: true });
    expect(onMessage).not.toHaveBeenCalled();
  });
});
