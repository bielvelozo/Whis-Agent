import { describe, it, expect } from 'vitest';
import { openDatabase, runMigrations, closeDatabase } from './db';

describe('db', () => {
  it('runs migrations idempotently', () => {
    const db = openDatabase(':memory:');
    runMigrations(db);
    runMigrations(db); // segunda chamada não deve falhar
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain('sessions');
    expect(names).toContain('messages');
    expect(names).toContain('schema_version');
    closeDatabase(db);
  });
});
