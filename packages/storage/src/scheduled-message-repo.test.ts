import { beforeEach, describe, expect, it } from 'vitest';
import { type Db, openDatabase, runMigrations } from './db';
import { type ScheduledMessageInsert, ScheduledMessageRepo } from './scheduled-message-repo';

const baseRecord = (overrides: Partial<ScheduledMessageInsert> = {}): ScheduledMessageInsert => ({
  chatId: 'tg:5864811662',
  title: 'lavar carro',
  kind: 'literal',
  payload: 'lavar o carro',
  recurrence: null,
  timezone: 'America/Sao_Paulo',
  nextFireAt: 1_900_000_000_000,
  lastFiredAt: null,
  paused: 0,
  createdAt: 1_800_000_000_000,
  createdCorrelationId: 'cid-test',
  ...overrides,
});

describe('ScheduledMessageRepo', () => {
  let db: Db;
  let repo: ScheduledMessageRepo;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db);
    repo = new ScheduledMessageRepo(db);
  });

  it('insert returns id and roundtrip via findById', () => {
    const id = repo.insert(baseRecord());
    expect(id).toBeGreaterThan(0);
    const got = repo.findById(id);
    expect(got).not.toBeNull();
    expect(got?.title).toBe('lavar carro');
    expect(got?.kind).toBe('literal');
    expect(got?.paused).toBe(0);
  });

  it('findDue returns only entries with next_fire_at <= now AND paused = 0', () => {
    const dueId = repo.insert(baseRecord({ title: 'due', nextFireAt: 1000 }));
    repo.insert(baseRecord({ title: 'future', nextFireAt: 9_000_000_000_000 }));
    repo.insert(baseRecord({ title: 'paused', nextFireAt: 500, paused: 1 }));
    const due = repo.findDue(2000);
    expect(due.map((r) => r.title)).toEqual(['due']);
    expect(due[0].id).toBe(dueId);
  });

  it('findDue at exact boundary returns the entry', () => {
    repo.insert(baseRecord({ nextFireAt: 5000 }));
    expect(repo.findDue(5000)).toHaveLength(1);
    expect(repo.findDue(4999)).toHaveLength(0);
  });

  it('list filter=active excludes paused', () => {
    repo.insert(baseRecord({ title: 'a' }));
    repo.insert(baseRecord({ title: 'b', paused: 1 }));
    expect(repo.list('active', 10).map((r) => r.title)).toEqual(['a']);
  });

  it('list filter=paused returns only paused', () => {
    repo.insert(baseRecord({ title: 'a' }));
    repo.insert(baseRecord({ title: 'b', paused: 1 }));
    expect(repo.list('paused', 10).map((r) => r.title)).toEqual(['b']);
  });

  it('list filter=all returns both', () => {
    repo.insert(baseRecord({ title: 'a' }));
    repo.insert(baseRecord({ title: 'b', paused: 1 }));
    expect(repo.list('all', 10)).toHaveLength(2);
  });

  it('list orders by next_fire_at ASC', () => {
    repo.insert(baseRecord({ title: 'late', nextFireAt: 3000 }));
    repo.insert(baseRecord({ title: 'early', nextFireAt: 1000 }));
    repo.insert(baseRecord({ title: 'mid', nextFireAt: 2000 }));
    expect(repo.list('all', 10).map((r) => r.title)).toEqual(['early', 'mid', 'late']);
  });

  it('list respects limit', () => {
    for (let i = 0; i < 5; i++) repo.insert(baseRecord({ nextFireAt: 1000 + i }));
    expect(repo.list('all', 3)).toHaveLength(3);
  });

  it('findByTitle does case-insensitive partial match', () => {
    repo.insert(baseRecord({ title: 'lavar o Carro' }));
    repo.insert(baseRecord({ title: 'comprar pão' }));
    expect(repo.findByTitle('carro')).toHaveLength(1);
    expect(repo.findByTitle('CARRO')).toHaveLength(1);
    expect(repo.findByTitle('inexistente')).toHaveLength(0);
  });

  it('markFired updates last_fired_at and next_fire_at atomically', () => {
    const id = repo.insert(baseRecord({ recurrence: '0 8 * * *', nextFireAt: 1000 }));
    repo.markFired(id, 1000, 86_400_000);
    const got = repo.findById(id);
    expect(got?.lastFiredAt).toBe(1000);
    expect(got?.nextFireAt).toBe(86_400_000);
  });

  it('delete removes the row', () => {
    const id = repo.insert(baseRecord());
    repo.delete(id);
    expect(repo.findById(id)).toBeNull();
  });

  it('pause sets paused=1', () => {
    const id = repo.insert(baseRecord());
    repo.pause(id);
    expect(repo.findById(id)?.paused).toBe(1);
  });

  it('resume sets paused=0 and updates next_fire_at', () => {
    const id = repo.insert(baseRecord({ paused: 1, nextFireAt: 1000 }));
    repo.resume(id, 5000);
    const got = repo.findById(id);
    expect(got?.paused).toBe(0);
    expect(got?.nextFireAt).toBe(5000);
  });

  it('update changes title/payload/nextFireAt atomically', () => {
    const id = repo.insert(baseRecord());
    repo.update(id, { title: 'novo', payload: 'novo payload', nextFireAt: 9000 });
    const got = repo.findById(id);
    expect(got?.title).toBe('novo');
    expect(got?.payload).toBe('novo payload');
    expect(got?.nextFireAt).toBe(9000);
  });

  it('update with partial fields leaves others intact', () => {
    const id = repo.insert(baseRecord({ title: 'orig', payload: 'orig payload' }));
    repo.update(id, { title: 'novo' });
    const got = repo.findById(id);
    expect(got?.title).toBe('novo');
    expect(got?.payload).toBe('orig payload');
  });

  it('rejects insert with invalid kind via CHECK constraint', () => {
    expect(() =>
      repo.insert(
        baseRecord({
          // biome-ignore lint/suspicious/noExplicitAny: intentional violation for test
          kind: 'invalid' as any,
        }),
      ),
    ).toThrow();
  });
});
