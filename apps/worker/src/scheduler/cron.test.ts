import { describe, expect, it } from 'vitest';
import { computeNextFire, validateCron } from '@/scheduler/cron';

describe('cron wrapper', () => {
  it('validateCron accepts valid 5-field expressions', () => {
    expect(validateCron('0 8 * * *')).toBe(true);
    expect(validateCron('*/15 * * * *')).toBe(true);
    expect(validateCron('30 9 * * 1-5')).toBe(true);
  });

  it('validateCron rejects malformed expressions', () => {
    expect(validateCron('0 25 * * *')).toBe(false);
    expect(validateCron('not a cron')).toBe(false);
    expect(validateCron('')).toBe(false);
  });

  it('computeNextFire returns ms timestamp in the future relative to from', () => {
    const from = new Date('2026-04-26T07:30:00-03:00').getTime();
    const next = computeNextFire('0 8 * * *', 'America/Sao_Paulo', from);
    expect(next).toBeGreaterThan(from);
    expect(new Date(next).toISOString()).toBe('2026-04-26T11:00:00.000Z');
  });

  it('computeNextFire rolls to next day when from is past today fire', () => {
    const from = new Date('2026-04-26T08:30:00-03:00').getTime();
    const next = computeNextFire('0 8 * * *', 'America/Sao_Paulo', from);
    expect(new Date(next).toISOString()).toBe('2026-04-27T11:00:00.000Z');
  });

  it('computeNextFire throws on invalid cron', () => {
    expect(() => computeNextFire('not a cron', 'America/Sao_Paulo', Date.now())).toThrow();
  });

  it('computeNextFire honors timezone (UTC vs SP differ)', () => {
    const from = new Date('2026-04-26T07:30:00Z').getTime();
    const nextUtc = computeNextFire('0 8 * * *', 'UTC', from);
    const nextSp = computeNextFire('0 8 * * *', 'America/Sao_Paulo', from);
    expect(nextUtc).not.toBe(nextSp);
  });
});
