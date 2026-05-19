import type { HabitLogRecord, HabitRecord } from '@whis/storage';

/** ISO weekday: 1=Mon..7=Sun */
function isoWeekday(date: string): number {
  const d = new Date(`${date}T00:00:00Z`);
  const wd = d.getUTCDay();
  return wd === 0 ? 7 : wd;
}

function addDays(date: string, delta: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function startOfIsoWeek(date: string): string {
  const wd = isoWeekday(date);
  return addDays(date, -(wd - 1));
}

function endOfIsoWeek(date: string): string {
  return addDays(startOfIsoWeek(date), 6);
}

export function expectsHabitOnDate(habit: HabitRecord, date: string): boolean {
  if (habit.cadence === 'daily') return true;
  if (habit.cadence === 'weekly') return true;
  if (!habit.daysOfWeek) return false;
  const expected = habit.daysOfWeek.split(',').map((s) => Number.parseInt(s, 10));
  return expected.includes(isoWeekday(date));
}

function sumForDate(logs: HabitLogRecord[], date: string): number {
  return logs.filter((l) => l.forDate === date).reduce((acc, l) => acc + l.value, 0);
}

function countDaysInRange(logs: HabitLogRecord[], from: string, to: string): number {
  const dates = new Set(
    logs.filter((l) => l.forDate >= from && l.forDate <= to).map((l) => l.forDate),
  );
  return dates.size;
}

export function isPendingForDate(
  habit: HabitRecord,
  logs: HabitLogRecord[],
  date: string,
): boolean {
  if (!expectsHabitOnDate(habit, date)) return false;

  if (habit.cadence === 'weekly') {
    const target = habit.targetPerPeriod ?? 1;
    const from = startOfIsoWeek(date);
    const to = endOfIsoWeek(date);
    return countDaysInRange(logs, from, to) < target;
  }

  const sum = sumForDate(logs, date);
  if (habit.kind === 'binary') return sum < 1;
  const target = habit.target ?? 0;
  return sum < target;
}

export function computeStreak(habit: HabitRecord, logs: HabitLogRecord[], asOf: string): number {
  if (habit.cadence === 'weekly') {
    let count = 0;
    let weekStart = startOfIsoWeek(asOf);
    let weekEnd = endOfIsoWeek(asOf);
    const target = habit.targetPerPeriod ?? 1;
    const guard = 520;
    for (let i = 0; i < guard; i++) {
      const days = countDaysInRange(logs, weekStart, weekEnd);
      if (days < target) break;
      count++;
      weekStart = addDays(weekStart, -7);
      weekEnd = addDays(weekEnd, -7);
    }
    return count;
  }

  let count = 0;
  let cursor = asOf;
  const guard = 365 * 5;
  for (let i = 0; i < guard; i++) {
    if (expectsHabitOnDate(habit, cursor)) {
      const sum = sumForDate(logs, cursor);
      const met = habit.kind === 'binary' ? sum >= 1 : sum >= (habit.target ?? 0);
      if (!met) break;
      count++;
    }
    cursor = addDays(cursor, -1);
  }
  return count;
}

export type PeriodAgg =
  | { kind: 'binary'; daysDone: number; total: number }
  | { kind: 'quantity'; sum: number; daysWithLog: number; avgPerDay: number }
  | { kind: 'duration'; sum: number; daysWithLog: number; avgPerDay: number };

export function aggregatePeriod(habit: HabitRecord, logs: HabitLogRecord[]): PeriodAgg {
  if (habit.kind === 'binary') {
    const days = new Set(logs.map((l) => l.forDate));
    return { kind: 'binary', daysDone: days.size, total: logs.length };
  }
  const sum = logs.reduce((acc, l) => acc + l.value, 0);
  const days = new Set(logs.map((l) => l.forDate));
  const daysWithLog = days.size;
  const avgPerDay = daysWithLog === 0 ? 0 : sum / daysWithLog;
  return { kind: habit.kind, sum, daysWithLog, avgPerDay };
}
