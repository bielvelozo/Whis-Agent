import type { Db } from './db.js';

export interface HabitLogRecord {
  id: number;
  habitId: number;
  value: number;
  loggedAt: number;
  forDate: string;
  createdAt: number;
  correlationId: string;
}

type DbRow = {
  id: number;
  habit_id: number;
  value: number;
  logged_at: number;
  for_date: string;
  created_at: number;
  correlation_id: string;
};

const fromRow = (r: DbRow): HabitLogRecord => ({
  id: r.id,
  habitId: r.habit_id,
  value: r.value,
  loggedAt: r.logged_at,
  forDate: r.for_date,
  createdAt: r.created_at,
  correlationId: r.correlation_id,
});

export class HabitLogRepo {
  constructor(private readonly db: Db) {}

  insert(rec: Omit<HabitLogRecord, 'id'>): number {
    const stmt = this.db.prepare(`
      INSERT INTO habit_logs (habit_id, value, logged_at, for_date, created_at, correlation_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(
      rec.habitId,
      rec.value,
      rec.loggedAt,
      rec.forDate,
      rec.createdAt,
      rec.correlationId,
    );
    return info.lastInsertRowid as number;
  }

  findByHabitAndDateRange(habitId: number, fromDate: string, toDate: string): HabitLogRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM habit_logs
         WHERE habit_id = ? AND for_date BETWEEN ? AND ?
         ORDER BY for_date ASC, logged_at ASC`,
      )
      .all(habitId, fromDate, toDate) as DbRow[];
    return rows.map(fromRow);
  }

  findLast(habitId: number, n: number): HabitLogRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM habit_logs WHERE habit_id = ? ORDER BY logged_at DESC LIMIT ?')
      .all(habitId, n) as DbRow[];
    return rows.map(fromRow);
  }

  /**
   * Deletes the most recent log of habit if it was created within `windowMs` of `now`.
   * Returns the deleted record or null if no log exists or it's outside the window.
   */
  deleteLast(habitId: number, now: number, windowMs: number): HabitLogRecord | null {
    const [last] = this.findLast(habitId, 1);
    if (!last) return null;
    if (now - last.loggedAt > windowMs) return null;
    this.db.prepare('DELETE FROM habit_logs WHERE id = ?').run(last.id);
    return last;
  }

  countByHabitForDate(habitId: number, date: string): number {
    const row = this.db
      .prepare(
        'SELECT COALESCE(SUM(value), 0) AS total FROM habit_logs WHERE habit_id = ? AND for_date = ?',
      )
      .get(habitId, date) as { total: number };
    return row.total;
  }

  /**
   * Count consecutive days going back from asOf with at least one log.
   * For weekly/custom_days cadences, stats.ts wraps this with cadence-aware logic.
   */
  streakDays(habitId: number, asOfDate: string): number {
    const rows = this.db
      .prepare(
        'SELECT DISTINCT for_date FROM habit_logs WHERE habit_id = ? AND for_date <= ? ORDER BY for_date DESC',
      )
      .all(habitId, asOfDate) as Array<{ for_date: string }>;
    const first = rows[0];
    if (!first) return 0;
    if (first.for_date !== asOfDate) return 0;

    let count = 0;
    let cursor = asOfDate;
    for (const r of rows) {
      if (r.for_date !== cursor) break;
      count++;
      const d = new Date(`${cursor}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - 1);
      cursor = d.toISOString().slice(0, 10);
    }
    return count;
  }
}
