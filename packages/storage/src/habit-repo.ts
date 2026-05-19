import type { Db } from './db.js';

export type HabitKind = 'binary' | 'quantity' | 'duration';
export type HabitCadence = 'daily' | 'weekly' | 'custom_days';

export interface HabitRecord {
  id: number;
  name: string;
  kind: HabitKind;
  unit: string | null;
  target: number | null;
  cadence: HabitCadence;
  targetPerPeriod: number | null;
  daysOfWeek: string | null;
  reminderScheduleId: number | null;
  createdAt: number;
  archivedAt: number | null;
}

type DbRow = {
  id: number;
  name: string;
  kind: HabitKind;
  unit: string | null;
  target: number | null;
  cadence: HabitCadence;
  target_per_period: number | null;
  days_of_week: string | null;
  reminder_schedule_id: number | null;
  created_at: number;
  archived_at: number | null;
};

const fromRow = (r: DbRow): HabitRecord => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  unit: r.unit,
  target: r.target,
  cadence: r.cadence,
  targetPerPeriod: r.target_per_period,
  daysOfWeek: r.days_of_week,
  reminderScheduleId: r.reminder_schedule_id,
  createdAt: r.created_at,
  archivedAt: r.archived_at,
});

export class HabitRepo {
  constructor(private readonly db: Db) {}

  insert(rec: Omit<HabitRecord, 'id'>): number {
    const stmt = this.db.prepare(`
      INSERT INTO habits
        (name, kind, unit, target, cadence, target_per_period, days_of_week,
         reminder_schedule_id, created_at, archived_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(
      rec.name,
      rec.kind,
      rec.unit,
      rec.target,
      rec.cadence,
      rec.targetPerPeriod,
      rec.daysOfWeek,
      rec.reminderScheduleId,
      rec.createdAt,
      rec.archivedAt,
    );
    return info.lastInsertRowid as number;
  }

  findById(id: number): HabitRecord | null {
    const row = this.db.prepare('SELECT * FROM habits WHERE id = ?').get(id) as DbRow | undefined;
    return row ? fromRow(row) : null;
  }

  findByName(query: string): HabitRecord | null {
    const row = this.db
      .prepare(
        'SELECT * FROM habits WHERE name LIKE ? COLLATE NOCASE ORDER BY archived_at IS NOT NULL, id ASC LIMIT 1',
      )
      .get(`%${query}%`) as DbRow | undefined;
    return row ? fromRow(row) : null;
  }

  list(filter: 'active' | 'archived' | 'all'): HabitRecord[] {
    let where = '';
    if (filter === 'active') where = 'WHERE archived_at IS NULL';
    if (filter === 'archived') where = 'WHERE archived_at IS NOT NULL';
    const rows = this.db.prepare(`SELECT * FROM habits ${where} ORDER BY id ASC`).all() as DbRow[];
    return rows.map(fromRow);
  }

  update(
    id: number,
    fields: Partial<
      Pick<HabitRecord, 'name' | 'unit' | 'target' | 'cadence' | 'targetPerPeriod' | 'daysOfWeek'>
    >,
  ): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (fields.name !== undefined) {
      sets.push('name = ?');
      values.push(fields.name);
    }
    if (fields.unit !== undefined) {
      sets.push('unit = ?');
      values.push(fields.unit);
    }
    if (fields.target !== undefined) {
      sets.push('target = ?');
      values.push(fields.target);
    }
    if (fields.cadence !== undefined) {
      sets.push('cadence = ?');
      values.push(fields.cadence);
    }
    if (fields.targetPerPeriod !== undefined) {
      sets.push('target_per_period = ?');
      values.push(fields.targetPerPeriod);
    }
    if (fields.daysOfWeek !== undefined) {
      sets.push('days_of_week = ?');
      values.push(fields.daysOfWeek);
    }
    if (sets.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE habits SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  setReminderScheduleId(id: number, scheduleId: number | null): void {
    this.db.prepare('UPDATE habits SET reminder_schedule_id = ? WHERE id = ?').run(scheduleId, id);
  }

  archive(id: number, at: number): void {
    this.db.prepare('UPDATE habits SET archived_at = ? WHERE id = ?').run(at, id);
  }

  unarchive(id: number): void {
    this.db.prepare('UPDATE habits SET archived_at = NULL WHERE id = ?').run(id);
  }
}
