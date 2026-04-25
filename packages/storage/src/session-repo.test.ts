import { beforeEach, describe, expect, it } from 'vitest';
import { type Db, openDatabase, runMigrations } from './db';
import { SessionRepo } from './session-repo';

describe('SessionRepo', () => {
  let db: Db;
  let repo: SessionRepo;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db);
    repo = new SessionRepo(db);
  });

  it('returns null for unknown chatId', () => {
    expect(repo.get('unknown')).toBeNull();
  });

  it('upserts and gets a session', () => {
    repo.upsert('chat1', 'sid-1', 1000);
    expect(repo.get('chat1')).toEqual({ sessionId: 'sid-1', lastMessageAt: 1000 });
  });

  it('upsert overwrites existing record', () => {
    repo.upsert('chat1', 'sid-1', 1000);
    repo.upsert('chat1', 'sid-2', 2000);
    expect(repo.get('chat1')).toEqual({ sessionId: 'sid-2', lastMessageAt: 2000 });
  });

  it('delete removes a session', () => {
    repo.upsert('chat1', 'sid-1', 1000);
    repo.delete('chat1');
    expect(repo.get('chat1')).toBeNull();
  });
});
