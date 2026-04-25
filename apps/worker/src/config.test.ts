// apps/worker/src/config.test.ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

const valid = {
  CLAUDE_CODE_OAUTH_TOKEN: 'tok',
  EVOLUTION_BASE_URL: 'http://evolution-api:8080',
  EVOLUTION_API_KEY: 'evo-key',
  EVOLUTION_INSTANCE: 'whis',
  WHATSAPP_OWNER_NUMBER: '5511999999999',
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
