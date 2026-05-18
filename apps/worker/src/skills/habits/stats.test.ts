import type { HabitLogRecord, HabitRecord } from '@whis/storage';
import { describe, expect, it } from 'vitest';
import { aggregatePeriod, computeStreak, expectsHabitOnDate, isPendingForDate } from './stats';

const habit = (overrides: Partial<HabitRecord> = {}): HabitRecord => ({
  id: 1,
  name: 'h',
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

const log = (forDate: string, value = 1, habitId = 1): HabitLogRecord => ({
  id: 1,
  habitId,
  value,
  loggedAt: 0,
  forDate,
  createdAt: 0,
  correlationId: 'c',
});

describe('expectsHabitOnDate', () => {
  it('daily: true on any day', () => {
    expect(expectsHabitOnDate(habit({ cadence: 'daily' }), '2026-05-18')).toBe(true);
  });

  it('weekly: true on any day', () => {
    expect(expectsHabitOnDate(habit({ cadence: 'weekly', targetPerPeriod: 3 }), '2026-05-18')).toBe(
      true,
    );
  });

  it('custom_days: true only on listed days (2026-05-18 = monday=1)', () => {
    expect(
      expectsHabitOnDate(habit({ cadence: 'custom_days', daysOfWeek: '1,3,5' }), '2026-05-18'),
    ).toBe(true);
    expect(
      expectsHabitOnDate(habit({ cadence: 'custom_days', daysOfWeek: '2,4,6' }), '2026-05-18'),
    ).toBe(false);
  });
});

describe('isPendingForDate', () => {
  it('binary daily: pending if no log; done if at least one', () => {
    const h = habit({ kind: 'binary', cadence: 'daily' });
    expect(isPendingForDate(h, [], '2026-05-18')).toBe(true);
    expect(isPendingForDate(h, [log('2026-05-18')], '2026-05-18')).toBe(false);
  });

  it('quantity daily: pending if sum < target', () => {
    const h = habit({ kind: 'quantity', cadence: 'daily', target: 30 });
    expect(isPendingForDate(h, [log('2026-05-18', 10), log('2026-05-18', 15)], '2026-05-18')).toBe(
      true,
    );
    expect(isPendingForDate(h, [log('2026-05-18', 30)], '2026-05-18')).toBe(false);
    expect(isPendingForDate(h, [log('2026-05-18', 100)], '2026-05-18')).toBe(false);
  });

  it('duration daily: same as quantity', () => {
    const h = habit({ kind: 'duration', cadence: 'daily', target: 10 });
    expect(isPendingForDate(h, [log('2026-05-18', 8)], '2026-05-18')).toBe(true);
    expect(isPendingForDate(h, [log('2026-05-18', 10)], '2026-05-18')).toBe(false);
  });

  it('weekly target: pending if count this week < targetPerPeriod', () => {
    const h = habit({ kind: 'binary', cadence: 'weekly', targetPerPeriod: 3 });
    expect(isPendingForDate(h, [log('2026-05-18'), log('2026-05-20')], '2026-05-21')).toBe(true);
    expect(
      isPendingForDate(h, [log('2026-05-18'), log('2026-05-19'), log('2026-05-20')], '2026-05-21'),
    ).toBe(false);
  });

  it('custom_days: not pending on non-target day', () => {
    const h = habit({ cadence: 'custom_days', daysOfWeek: '2,4,6' });
    expect(isPendingForDate(h, [], '2026-05-18')).toBe(false);
  });
});

describe('computeStreak', () => {
  it('daily: consecutive days', () => {
    const h = habit({ cadence: 'daily' });
    const logs = [log('2026-05-16'), log('2026-05-17'), log('2026-05-18')];
    expect(computeStreak(h, logs, '2026-05-18')).toBe(3);
  });

  it('daily: 0 if today missing', () => {
    const h = habit({ cadence: 'daily' });
    const logs = [log('2026-05-16'), log('2026-05-17')];
    expect(computeStreak(h, logs, '2026-05-18')).toBe(0);
  });

  it('custom_days: skips off-days from streak count', () => {
    const h = habit({ cadence: 'custom_days', daysOfWeek: '1,3,5' });
    const logs = [log('2026-05-11'), log('2026-05-13'), log('2026-05-15'), log('2026-05-18')];
    expect(computeStreak(h, logs, '2026-05-18')).toBe(4);
  });

  it('weekly target: streak counts weeks where target was met', () => {
    const h = habit({ cadence: 'weekly', targetPerPeriod: 3 });
    const logs = [
      log('2026-05-04'),
      log('2026-05-05'),
      log('2026-05-12'),
      log('2026-05-13'),
      log('2026-05-14'),
      log('2026-05-18'),
      log('2026-05-19'),
      log('2026-05-20'),
    ];
    expect(computeStreak(h, logs, '2026-05-20')).toBe(2);
  });
});

describe('aggregatePeriod', () => {
  it('binary: count of distinct days', () => {
    const h = habit({ kind: 'binary' });
    const logs = [log('2026-05-16'), log('2026-05-17'), log('2026-05-17')];
    expect(aggregatePeriod(h, logs)).toEqual({ kind: 'binary', daysDone: 2, total: 3 });
  });

  it('quantity: sum and avg-per-day', () => {
    const h = habit({ kind: 'quantity' });
    const logs = [log('2026-05-16', 10), log('2026-05-17', 20)];
    expect(aggregatePeriod(h, logs)).toEqual({
      kind: 'quantity',
      sum: 30,
      daysWithLog: 2,
      avgPerDay: 15,
    });
  });

  it('duration: sum and avg-per-day', () => {
    const h = habit({ kind: 'duration' });
    const logs = [log('2026-05-16', 30), log('2026-05-17', 45)];
    expect(aggregatePeriod(h, logs)).toEqual({
      kind: 'duration',
      sum: 75,
      daysWithLog: 2,
      avgPerDay: 37.5,
    });
  });

  it('empty logs returns zero values', () => {
    expect(aggregatePeriod(habit({ kind: 'binary' }), [])).toEqual({
      kind: 'binary',
      daysDone: 0,
      total: 0,
    });
  });
});
