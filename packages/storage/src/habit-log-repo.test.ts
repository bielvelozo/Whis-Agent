import { beforeEach, describe, expect, it } from 'vitest';
import { type Db, openDatabase, runMigrations } from './db.js';
import { type HabitLogRecord, HabitLogRepo } from './habit-log-repo.js';
import { HabitRepo } from './habit-repo.js';

const baseLog = (
  habitId: number,
  overrides: Partial<Omit<HabitLogRecord, 'id'>> = {},
): Omit<HabitLogRecord, 'id'> => ({
  habitId,
  value: 1,
  loggedAt: 1_700_000_000_000,
  forDate: '2026-05-18',
  createdAt: 1_700_000_000_000,
  correlationId: 'c1',
  ...overrides,
});

describe('HabitLogRepo', () => {
  let db: Db;
  let habits: HabitRepo;
  let logs: HabitLogRepo;
  let habitId: number;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db);
    habits = new HabitRepo(db);
    logs = new HabitLogRepo(db);
    habitId = habits.insert({
      name: 'meditar',
      kind: 'duration',
      unit: 'min',
      target: 10,
      cadence: 'daily',
      targetPerPeriod: null,
      daysOfWeek: null,
      reminderScheduleId: null,
      createdAt: 1_700_000_000_000,
      archivedAt: null,
    });
  });

  it('insert returns id and persists', () => {
    const id = logs.insert(baseLog(habitId));
    expect(id).toBeGreaterThan(0);
    const range = logs.findByHabitAndDateRange(habitId, '2026-05-01', '2026-05-31');
    expect(range).toHaveLength(1);
    expect(range[0].value).toBe(1);
  });

  it('findByHabitAndDateRange returns sorted asc by for_date', () => {
    logs.insert(baseLog(habitId, { forDate: '2026-05-18', value: 10 }));
    logs.insert(baseLog(habitId, { forDate: '2026-05-16', value: 5 }));
    logs.insert(baseLog(habitId, { forDate: '2026-05-17', value: 8 }));
    const range = logs.findByHabitAndDateRange(habitId, '2026-05-01', '2026-05-31');
    expect(range.map((l) => l.forDate)).toEqual(['2026-05-16', '2026-05-17', '2026-05-18']);
  });

  it('findByHabitAndDateRange excludes other habits', () => {
    const other = habits.insert({
      name: 'ler',
      kind: 'binary',
      unit: null,
      target: null,
      cadence: 'daily',
      targetPerPeriod: null,
      daysOfWeek: null,
      reminderScheduleId: null,
      createdAt: 1_700_000_000_000,
      archivedAt: null,
    });
    logs.insert(baseLog(habitId, { forDate: '2026-05-18' }));
    logs.insert(baseLog(other, { forDate: '2026-05-18' }));
    expect(logs.findByHabitAndDateRange(habitId, '2026-05-01', '2026-05-31')).toHaveLength(1);
  });

  it('findLast returns N most recent by loggedAt desc', () => {
    logs.insert(baseLog(habitId, { loggedAt: 100, forDate: '2026-05-15' }));
    logs.insert(baseLog(habitId, { loggedAt: 300, forDate: '2026-05-17' }));
    logs.insert(baseLog(habitId, { loggedAt: 200, forDate: '2026-05-16' }));
    const last2 = logs.findLast(habitId, 2);
    expect(last2.map((l) => l.loggedAt)).toEqual([300, 200]);
  });

  it('deleteLast within window deletes most recent log only', () => {
    const id1 = logs.insert(baseLog(habitId, { loggedAt: 100 }));
    const id2 = logs.insert(baseLog(habitId, { loggedAt: 200 }));
    const deleted = logs.deleteLast(habitId, 300, 1000);
    expect(deleted?.id).toBe(id2);
    const remaining = logs.findLast(habitId, 5);
    expect(remaining.map((l) => l.id)).toEqual([id1]);
  });

  it('deleteLast outside window returns null and deletes nothing', () => {
    logs.insert(baseLog(habitId, { loggedAt: 100 }));
    const deleted = logs.deleteLast(habitId, 10_000, 1000);
    expect(deleted).toBeNull();
    expect(logs.findLast(habitId, 5)).toHaveLength(1);
  });

  it('countByHabitForDate sums values for a date', () => {
    logs.insert(baseLog(habitId, { forDate: '2026-05-18', value: 30 }));
    logs.insert(baseLog(habitId, { forDate: '2026-05-18', value: 15 }));
    logs.insert(baseLog(habitId, { forDate: '2026-05-17', value: 99 }));
    expect(logs.countByHabitForDate(habitId, '2026-05-18')).toBe(45);
    expect(logs.countByHabitForDate(habitId, '2026-05-19')).toBe(0);
  });

  it('streakDays counts consecutive days back from asOf for daily cadence', () => {
    logs.insert(baseLog(habitId, { forDate: '2026-05-15' }));
    logs.insert(baseLog(habitId, { forDate: '2026-05-16' }));
    logs.insert(baseLog(habitId, { forDate: '2026-05-17' }));
    logs.insert(baseLog(habitId, { forDate: '2026-05-18' }));
    expect(logs.streakDays(habitId, '2026-05-18')).toBe(4);
  });

  it('streakDays breaks on gap', () => {
    logs.insert(baseLog(habitId, { forDate: '2026-05-15' }));
    logs.insert(baseLog(habitId, { forDate: '2026-05-17' }));
    logs.insert(baseLog(habitId, { forDate: '2026-05-18' }));
    expect(logs.streakDays(habitId, '2026-05-18')).toBe(2);
  });

  it('streakDays returns 0 if asOf has no log', () => {
    logs.insert(baseLog(habitId, { forDate: '2026-05-16' }));
    expect(logs.streakDays(habitId, '2026-05-18')).toBe(0);
  });

  it('FK ON DELETE CASCADE removes logs when habit is deleted', () => {
    logs.insert(baseLog(habitId));
    db.prepare('DELETE FROM habits WHERE id = ?').run(habitId);
    expect(logs.findLast(habitId, 5)).toHaveLength(0);
  });
});
