import type { Db } from './db';

export interface SessionRecord {
  sessionId: string;
  lastMessageAt: number;
}

export class SessionRepo {
  private readonly stmtGet;
  private readonly stmtUpsert;
  private readonly stmtDelete;

  constructor(db: Db) {
    this.stmtGet = db.prepare(
      'SELECT session_id as sessionId, last_message_at as lastMessageAt FROM sessions WHERE chat_id = ?',
    );
    this.stmtUpsert = db.prepare(
      `INSERT INTO sessions (chat_id, session_id, last_message_at) VALUES (?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET session_id = excluded.session_id, last_message_at = excluded.last_message_at`,
    );
    this.stmtDelete = db.prepare('DELETE FROM sessions WHERE chat_id = ?');
  }

  get(chatId: string): SessionRecord | null {
    const row = this.stmtGet.get(chatId) as SessionRecord | undefined;
    return row ?? null;
  }

  upsert(chatId: string, sessionId: string, lastMessageAt: number): void {
    this.stmtUpsert.run(chatId, sessionId, lastMessageAt);
  }

  delete(chatId: string): void {
    this.stmtDelete.run(chatId);
  }
}
