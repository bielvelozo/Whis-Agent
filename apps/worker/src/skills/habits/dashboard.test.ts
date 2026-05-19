import type { HabitLogRecord, HabitRecord } from '@whis/storage';
import { describe, expect, it } from 'vitest';
import { renderDashboard } from './dashboard';

const habit = (overrides: Partial<HabitRecord> = {}): HabitRecord => ({
  id: 1,
  name: 'meditar',
  kind: 'binary',
  unit: null,
  target: null,
  cadence: 'daily',
  targetPerPeriod: null,
  daysOfWeek: null,
  reminderScheduleId: null,
  createdAt: 0,
  archivedAt: null,
  ...overrides,
});

const log = (habitId: number, forDate: string, value = 1): HabitLogRecord => ({
  id: 1,
  habitId,
  value,
  loggedAt: 0,
  forDate,
  createdAt: 0,
  correlationId: 'c',
});

describe('renderDashboard', () => {
  it('renders empty state when no habits', () => {
    const out = renderDashboard({ habits: [], logs: [], asOf: '2026-05-18' });
    expect(out).toContain('# Habits Dashboard');
    expect(out).toContain('Nenhum hábito ativo');
  });

  it('renders single habit with heatmap', () => {
    const h = habit({ id: 1, name: 'meditar' });
    const logs = [log(1, '2026-05-18'), log(1, '2026-05-17')];
    const out = renderDashboard({ habits: [h], logs, asOf: '2026-05-18' });
    expect(out).toContain('## meditar');
    expect(out).toContain('Streak:** 2');
    expect(out).toMatch(/✅/);
    expect(out).toMatch(/⬜/);
  });

  it('binary done is ✅, pending is ⬜', () => {
    const h = habit({ kind: 'binary', cadence: 'daily' });
    const out = renderDashboard({
      habits: [h],
      logs: [log(1, '2026-05-18')],
      asOf: '2026-05-18',
    });
    const heatmapLine = out.split('\n').find((l) => l.includes('✅') || l.includes('⬜'));
    expect(heatmapLine).toBeDefined();
  });

  it('quantity partial is 🟧, full is ✅', () => {
    const h = habit({ kind: 'quantity', cadence: 'daily', target: 30 });
    const logs = [log(1, '2026-05-18', 15), log(1, '2026-05-17', 30)];
    const out = renderDashboard({ habits: [h], logs, asOf: '2026-05-18' });
    expect(out).toContain('🟧');
    expect(out).toContain('✅');
  });

  it('custom_days off-day shows ▫️', () => {
    const h = habit({ cadence: 'custom_days', daysOfWeek: '1,3,5' });
    const out = renderDashboard({ habits: [h], logs: [], asOf: '2026-05-18' });
    expect(out).toContain('▫️');
  });

  it('multiple habits each get a section', () => {
    const a = habit({ id: 1, name: 'meditar' });
    const b = habit({ id: 2, name: 'malhação', cadence: 'weekly', targetPerPeriod: 3 });
    const out = renderDashboard({ habits: [a, b], logs: [], asOf: '2026-05-18' });
    expect(out).toContain('## meditar');
    expect(out).toContain('## malhação');
  });

  it('includes asOf in header', () => {
    const out = renderDashboard({ habits: [], logs: [], asOf: '2026-05-18' });
    expect(out).toContain('2026-05-18');
  });

  it('archived habits are excluded', () => {
    const a = habit({ id: 1, name: 'old', archivedAt: 999 });
    const out = renderDashboard({ habits: [a], logs: [], asOf: '2026-05-18' });
    expect(out).not.toContain('## old');
  });
});
