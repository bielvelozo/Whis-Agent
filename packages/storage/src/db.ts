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

const MIGRATION_002 = `
CREATE TABLE scheduled_messages (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id                  TEXT    NOT NULL,
  title                    TEXT    NOT NULL,
  kind                     TEXT    NOT NULL CHECK (kind IN ('literal','agent')),
  payload                  TEXT    NOT NULL,
  recurrence               TEXT,
  timezone                 TEXT    NOT NULL DEFAULT 'America/Sao_Paulo',
  next_fire_at             INTEGER NOT NULL,
  last_fired_at            INTEGER,
  paused                   INTEGER NOT NULL DEFAULT 0,
  created_at               INTEGER NOT NULL,
  created_correlation_id   TEXT    NOT NULL
);
CREATE INDEX idx_scheduled_due ON scheduled_messages (next_fire_at, paused);
`;

const MIGRATION_003 = `
CREATE TABLE habits (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  name                   TEXT    NOT NULL UNIQUE,
  kind                   TEXT    NOT NULL CHECK (kind IN ('binary','quantity','duration')),
  unit                   TEXT,
  target                 REAL,
  cadence                TEXT    NOT NULL CHECK (cadence IN ('daily','weekly','custom_days')),
  target_per_period      INTEGER,
  days_of_week           TEXT,
  reminder_schedule_id   INTEGER REFERENCES scheduled_messages(id) ON DELETE SET NULL,
  created_at             INTEGER NOT NULL,
  archived_at            INTEGER
);

CREATE TABLE habit_logs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  habit_id        INTEGER NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
  value           REAL    NOT NULL,
  logged_at       INTEGER NOT NULL,
  for_date        TEXT    NOT NULL,
  created_at      INTEGER NOT NULL,
  correlation_id  TEXT    NOT NULL
);
CREATE INDEX idx_habit_logs_habit_date ON habit_logs (habit_id, for_date);
`;

const MIGRATIONS: Migration[] = [
  { version: 1, filename: '001_initial.sql', sql: MIGRATION_001 },
  { version: 2, filename: '002_scheduled_messages.sql', sql: MIGRATION_002 },
  { version: 3, filename: '003_habits.sql', sql: MIGRATION_003 },
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
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
        migration.version,
        Date.now(),
      );
    });
    tx();
  }
}
