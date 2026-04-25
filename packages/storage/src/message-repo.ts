import type { Db } from './db.js';

export interface MessageRecord {
  chatId: string;
  direction: 'in' | 'out';
  text: string;
  correlationId: string;
  messageRef: string | null;
  at: number;
}

export class MessageRepo {
  private readonly stmtInsert;
  private readonly stmtRecent;

  constructor(db: Db) {
    this.stmtInsert = db.prepare(
      `INSERT INTO messages (chat_id, direction, text, correlation_id, message_ref, at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.stmtRecent = db.prepare(
      `SELECT chat_id as chatId, direction, text, correlation_id as correlationId,
              message_ref as messageRef, at
       FROM messages
       WHERE chat_id = ?
       ORDER BY at DESC
       LIMIT ?`,
    );
  }

  insert(record: MessageRecord): void {
    this.stmtInsert.run(
      record.chatId,
      record.direction,
      record.text,
      record.correlationId,
      record.messageRef,
      record.at,
    );
  }

  recent(chatId: string, limit: number): MessageRecord[] {
    return this.stmtRecent.all(chatId, limit) as MessageRecord[];
  }
}
