import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, runMigrations, type Db } from './db';
import { MessageRepo } from './message-repo';

describe('MessageRepo', () => {
  let db: Db;
  let repo: MessageRepo;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db);
    repo = new MessageRepo(db);
  });

  it('inserts and retrieves recent messages in DESC order', () => {
    repo.insert({ chatId: 'c1', direction: 'in', text: 'oi', correlationId: 'cid-1', messageRef: 'mref-1', at: 1000 });
    repo.insert({ chatId: 'c1', direction: 'out', text: 'eai', correlationId: 'cid-1', messageRef: null, at: 2000 });
    const recent = repo.recent('c1', 10);
    expect(recent).toHaveLength(2);
    expect(recent[0].at).toBe(2000);
    expect(recent[1].at).toBe(1000);
  });

  it('respects the limit', () => {
    for (let i = 0; i < 5; i++) {
      repo.insert({ chatId: 'c1', direction: 'in', text: `m${i}`, correlationId: `cid-${i}`, messageRef: null, at: 1000 + i });
    }
    expect(repo.recent('c1', 3)).toHaveLength(3);
  });

  it('filters by chatId', () => {
    repo.insert({ chatId: 'c1', direction: 'in', text: 'a', correlationId: 'x', messageRef: null, at: 1 });
    repo.insert({ chatId: 'c2', direction: 'in', text: 'b', correlationId: 'y', messageRef: null, at: 2 });
    expect(repo.recent('c1', 10)).toHaveLength(1);
    expect(repo.recent('c2', 10)).toHaveLength(1);
  });
});
