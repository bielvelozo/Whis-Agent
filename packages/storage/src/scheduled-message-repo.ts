import type { Db } from './db.js';

export interface ScheduledMessageRecord {
  id: number;
  chatId: string;
  title: string;
  kind: 'literal' | 'agent';
  payload: string;
  recurrence: string | null;
  timezone: string;
  nextFireAt: number;
  lastFiredAt: number | null;
  paused: 0 | 1;
  createdAt: number;
  createdCorrelationId: string;
}

export type ScheduledMessageInsert = Omit<ScheduledMessageRecord, 'id'>;

export type ListFilter = 'active' | 'paused' | 'all';

export interface UpdateFields {
  title?: string;
  payload?: string;
  nextFireAt?: number;
  recurrence?: string | null;
  timezone?: string;
}

const SELECT_BASE = `SELECT
  id,
  chat_id           AS chatId,
  title,
  kind,
  payload,
  recurrence,
  timezone,
  next_fire_at      AS nextFireAt,
  last_fired_at     AS lastFiredAt,
  paused,
  created_at        AS createdAt,
  created_correlation_id AS createdCorrelationId
FROM scheduled_messages`;

export class ScheduledMessageRepo {
  private readonly stmtInsert;
  private readonly stmtFindById;
  private readonly stmtFindByTitle;
  private readonly stmtFindDue;
  private readonly stmtListActive;
  private readonly stmtListPaused;
  private readonly stmtListAll;
  private readonly stmtMarkFired;
  private readonly stmtDelete;
  private readonly stmtPause;
  private readonly stmtResume;

  constructor(private readonly db: Db) {
    this.stmtInsert = db.prepare(
      `INSERT INTO scheduled_messages
        (chat_id, title, kind, payload, recurrence, timezone,
         next_fire_at, last_fired_at, paused, created_at, created_correlation_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stmtFindById = db.prepare(`${SELECT_BASE} WHERE id = ?`);
    this.stmtFindByTitle = db.prepare(
      `${SELECT_BASE} WHERE LOWER(title) LIKE LOWER(?) ORDER BY next_fire_at ASC`,
    );
    this.stmtFindDue = db.prepare(
      `${SELECT_BASE} WHERE next_fire_at <= ? AND paused = 0 ORDER BY next_fire_at ASC`,
    );
    this.stmtListActive = db.prepare(
      `${SELECT_BASE} WHERE paused = 0 ORDER BY next_fire_at ASC LIMIT ?`,
    );
    this.stmtListPaused = db.prepare(
      `${SELECT_BASE} WHERE paused = 1 ORDER BY next_fire_at ASC LIMIT ?`,
    );
    this.stmtListAll = db.prepare(`${SELECT_BASE} ORDER BY next_fire_at ASC LIMIT ?`);
    this.stmtMarkFired = db.prepare(
      `UPDATE scheduled_messages SET last_fired_at = ?, next_fire_at = ? WHERE id = ?`,
    );
    this.stmtDelete = db.prepare(`DELETE FROM scheduled_messages WHERE id = ?`);
    this.stmtPause = db.prepare(`UPDATE scheduled_messages SET paused = 1 WHERE id = ?`);
    this.stmtResume = db.prepare(
      `UPDATE scheduled_messages SET paused = 0, next_fire_at = ? WHERE id = ?`,
    );
  }

  insert(rec: ScheduledMessageInsert): number {
    const result = this.stmtInsert.run(
      rec.chatId,
      rec.title,
      rec.kind,
      rec.payload,
      rec.recurrence,
      rec.timezone,
      rec.nextFireAt,
      rec.lastFiredAt,
      rec.paused,
      rec.createdAt,
      rec.createdCorrelationId,
    );
    return Number(result.lastInsertRowid);
  }

  findById(id: number): ScheduledMessageRecord | null {
    const row = this.stmtFindById.get(id) as ScheduledMessageRecord | undefined;
    return row ?? null;
  }

  findByTitle(query: string): ScheduledMessageRecord[] {
    return this.stmtFindByTitle.all(`%${query}%`) as ScheduledMessageRecord[];
  }

  findDue(now: number): ScheduledMessageRecord[] {
    return this.stmtFindDue.all(now) as ScheduledMessageRecord[];
  }

  list(filter: ListFilter, limit: number): ScheduledMessageRecord[] {
    if (filter === 'active') return this.stmtListActive.all(limit) as ScheduledMessageRecord[];
    if (filter === 'paused') return this.stmtListPaused.all(limit) as ScheduledMessageRecord[];
    return this.stmtListAll.all(limit) as ScheduledMessageRecord[];
  }

  markFired(id: number, lastFiredAt: number, nextFireAt: number): void {
    this.stmtMarkFired.run(lastFiredAt, nextFireAt, id);
  }

  delete(id: number): void {
    this.stmtDelete.run(id);
  }

  pause(id: number): void {
    this.stmtPause.run(id);
  }

  resume(id: number, nextFireAt: number): void {
    this.stmtResume.run(nextFireAt, id);
  }

  update(id: number, fields: UpdateFields): void {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    if (fields.title !== undefined) {
      sets.push('title = ?');
      values.push(fields.title);
    }
    if (fields.payload !== undefined) {
      sets.push('payload = ?');
      values.push(fields.payload);
    }
    if (fields.nextFireAt !== undefined) {
      sets.push('next_fire_at = ?');
      values.push(fields.nextFireAt);
    }
    if (fields.recurrence !== undefined) {
      sets.push('recurrence = ?');
      values.push(fields.recurrence);
    }
    if (fields.timezone !== undefined) {
      sets.push('timezone = ?');
      values.push(fields.timezone);
    }
    if (sets.length === 0) return;
    values.push(id);
    const sql = `UPDATE scheduled_messages SET ${sets.join(', ')} WHERE id = ?`;
    this.db.prepare(sql).run(...values);
  }
}
