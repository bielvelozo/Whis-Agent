import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSystemPrompt } from '@/agent/system-prompt';

afterEach(() => {
  vi.unstubAllEnvs();
});

const SOUL = '# SOUL\nWhis is calm and concise.';
const USER = '# Gabriel\nProfessional context goes here.';
const SKILL = '## Calendar skill\nUse this when asked about calendar.';

describe('buildSystemPrompt', () => {
  it('omits Deployment context block when WHIS_AUTH_TUNNEL_HINT is unset', () => {
    vi.stubEnv('WHIS_AUTH_TUNNEL_HINT', '');

    const out = buildSystemPrompt(SOUL, USER, [SKILL]);

    expect(out).not.toContain('Deployment context');
    expect(out).not.toContain('SSH tunnel');
    expect(out).not.toContain('OAuth');
  });

  it('omits Deployment context block when WHIS_AUTH_TUNNEL_HINT is whitespace-only', () => {
    vi.stubEnv('WHIS_AUTH_TUNNEL_HINT', '   \t  ');

    const out = buildSystemPrompt(SOUL, USER, [SKILL]);

    expect(out).not.toContain('Deployment context');
  });

  it('injects Deployment context block with literal tunnel command when WHIS_AUTH_TUNNEL_HINT is set', () => {
    const hint = 'ssh -L 3500:localhost:3500 ubuntu@host';
    vi.stubEnv('WHIS_AUTH_TUNNEL_HINT', hint);

    const out = buildSystemPrompt(SOUL, USER, [SKILL]);

    expect(out).toContain('# Deployment context');
    expect(out).toContain('SSH tunnel');
    expect(out).toContain(hint);
  });

  it('orders sections as SOUL → About the user → Deployment context → Active skills', () => {
    const hint = 'ssh -L 3500:localhost:3500 ubuntu@host';
    vi.stubEnv('WHIS_AUTH_TUNNEL_HINT', hint);

    const out = buildSystemPrompt(SOUL, USER, [SKILL]);

    const soulIdx = out.indexOf('Whis is calm and concise.');
    const userIdx = out.indexOf('# About the user');
    const deployIdx = out.indexOf('# Deployment context');
    const skillsIdx = out.indexOf('# Active skills');

    expect(soulIdx).toBeGreaterThanOrEqual(0);
    expect(userIdx).toBeGreaterThan(soulIdx);
    expect(deployIdx).toBeGreaterThan(userIdx);
    expect(skillsIdx).toBeGreaterThan(deployIdx);
  });

  it('still injects Deployment context when there are no active skills', () => {
    const hint = 'ssh -L 3500:localhost:3500 ubuntu@host';
    vi.stubEnv('WHIS_AUTH_TUNNEL_HINT', hint);

    const out = buildSystemPrompt(SOUL, USER, []);

    expect(out).toContain('# Deployment context');
    expect(out).toContain(hint);
    expect(out).not.toContain('# Active skills');
  });
});
