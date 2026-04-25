import Database from 'better-sqlite3';

export type Db = Database.Database;

export function openDatabase(path: string): Db {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

export function closeDatabase(db: Db): void {
  db.close();
}

interface Migration {
  version: number;
  filename: string;
  sql: string;
}

const MIGRATION_001 = `
CREATE TABLE sessions (
  chat_id         TEXT    PRIMARY KEY,
  session_id      TEXT    NOT NULL,
  last_message_at INTEGER NOT NULL
);

CREATE TABLE messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id         TEXT    NOT NULL,
  direction       TEXT    NOT NULL CHECK (direction IN ('in','out')),
  text            TEXT    NOT NULL,
  correlation_id  TEXT    NOT NULL,
  message_ref     TEXT,
  at              INTEGER NOT NULL
);
CREATE INDEX idx_messages_chat_at ON messages (chat_id, at DESC);
`;

const MIGRATIONS: Migration[] = [
  { version: 1, filename: '001_initial.sql', sql: MIGRATION_001 },
];

export function runMigrations(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version    INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  const currentVersion =
    (
      db.prepare('SELECT MAX(version) as v FROM schema_version').get() as {
        v: number | null;
      }
    ).v ?? 0;

  const pending = MIGRATIONS.filter((m) => m.version > currentVersion);

  for (const migration of pending) {
    const tx = db.transaction(() => {
      db.exec(migration.sql);
      db.prepare(
        'INSERT INTO schema_version (version, applied_at) VALUES (?, ?)',
      ).run(migration.version, Date.now());
    });
    tx();
  }
}
