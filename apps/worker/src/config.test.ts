// apps/worker/src/config.test.ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

const valid = {
  CLAUDE_CODE_OAUTH_TOKEN: 'tok',
  WHATSAPP_ENABLED: 'true',
  EVOLUTION_BASE_URL: 'http://evolution-api:8080',
  EVOLUTION_API_KEY: 'evo-key',
  EVOLUTION_INSTANCE: 'whis',
  WHATSAPP_OWNER_NUMBER: '5511999999999',
  TELEGRAM_ENABLED: 'false',
  WORKSPACE_DIR: '/app/context',
  DATA_DIR: '/app/data',
  WEBHOOK_PORT: '8080',
  SESSION_IDLE_HOURS: '6',
  LOG_LEVEL: 'info',
  WHIS_BACKEND: 'claude-code',
};

describe('loadConfig', () => {
  it('parses a valid env into a typed Config', () => {
    const cfg = loadConfig(valid);
    expect(cfg.evolution.baseUrl).toBe('http://evolution-api:8080');
    expect(cfg.whatsapp.ownerNumber).toBe('5511999999999');
    expect(cfg.workspaceDir).toBe('/app/context');
    expect(cfg.sessionIdleHours).toBe(6);
    expect(cfg.backend).toBe('claude-code');
  });

  it('throws when CLAUDE_CODE_OAUTH_TOKEN missing', () => {
    const broken = { ...valid, CLAUDE_CODE_OAUTH_TOKEN: '' };
    expect(() => loadConfig(broken)).toThrow(/Invalid environment/);
  });

  it('throws on non-numeric WEBHOOK_PORT', () => {
    const broken = { ...valid, WEBHOOK_PORT: 'abc' };
    expect(() => loadConfig(broken)).toThrow();
  });
});

describe('channel flags', () => {
  const baseTelegram = {
    CLAUDE_CODE_OAUTH_TOKEN: 'abc',
    TELEGRAM_ENABLED: 'true',
    TELEGRAM_BOT_TOKEN: '123:ABC',
    TELEGRAM_OWNER_CHAT_ID: '5511999999999',
    WHATSAPP_ENABLED: 'false',
  };

  it('aceita só Telegram habilitado', () => {
    const c = loadConfig(baseTelegram);
    expect(c.telegram.enabled).toBe(true);
    expect(c.telegram.ownerChatId).toBe(5511999999999);
    expect(c.telegram.botToken).toBe('123:ABC');
    expect(c.whatsapp.enabled).toBe(false);
  });

  it('aceita ambos canais habilitados', () => {
    const c = loadConfig({
      ...baseTelegram,
      WHATSAPP_ENABLED: 'true',
      EVOLUTION_BASE_URL: 'http://evolution-api:8080',
      EVOLUTION_API_KEY: 'k',
      WHATSAPP_OWNER_NUMBER: '5511999999999',
    });
    expect(c.telegram.enabled).toBe(true);
    expect(c.whatsapp.enabled).toBe(true);
  });

  it('rejeita ambos canais desabilitados', () => {
    expect(() =>
      loadConfig({ ...baseTelegram, TELEGRAM_ENABLED: 'false', WHATSAPP_ENABLED: 'false' }),
    ).toThrow(/pelo menos um canal/);
  });

  it('rejeita TELEGRAM_ENABLED sem TOKEN', () => {
    const broken: Record<string, string> = { ...baseTelegram };
    delete broken.TELEGRAM_BOT_TOKEN;
    expect(() => loadConfig(broken)).toThrow(/TELEGRAM_BOT_TOKEN/);
  });

  it('rejeita TELEGRAM_ENABLED sem OWNER_CHAT_ID', () => {
    const broken: Record<string, string> = { ...baseTelegram };
    delete broken.TELEGRAM_OWNER_CHAT_ID;
    expect(() => loadConfig(broken)).toThrow(/TELEGRAM_OWNER_CHAT_ID/);
  });

  it('rejeita WHATSAPP_ENABLED sem EVOLUTION_BASE_URL', () => {
    expect(() =>
      loadConfig({
        ...baseTelegram,
        WHATSAPP_ENABLED: 'true',
        EVOLUTION_API_KEY: 'k',
        WHATSAPP_OWNER_NUMBER: '5511999999999',
      }),
    ).toThrow(/EVOLUTION_BASE_URL/);
  });
});
