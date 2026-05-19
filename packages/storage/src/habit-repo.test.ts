import { beforeEach, describe, expect, it } from 'vitest';
import { type Db, openDatabase, runMigrations } from './db.js';
import { type HabitRecord, HabitRepo } from './habit-repo.js';
import { ScheduledMessageRepo } from './scheduled-message-repo.js';

const baseHabit = (overrides: Partial<Omit<HabitRecord, 'id'>> = {}): Omit<HabitRecord, 'id'> => ({
  name: 'meditar',
  kind: 'duration',
  unit: 'min',
  target: 10,
  cadence: 'daily',
  targetPerPeriod: null,
  daysOfWeek: null,
  reminderScheduleId: null,
  createdAt: 1_700_000_000_000,
  archivedAt: null,
  ...overrides,
});

describe('HabitRepo', () => {
  let db: Db;
  let repo: HabitRepo;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db);
    repo = new HabitRepo(db);
  });

  it('insert returns id and persists fields', () => {
    const id = repo.insert(baseHabit());
    expect(id).toBeGreaterThan(0);
    const found = repo.findById(id);
    expect(found?.name).toBe('meditar');
    expect(found?.kind).toBe('duration');
    expect(found?.target).toBe(10);
  });

  it('insert rejects duplicate name', () => {
    repo.insert(baseHabit({ name: 'meditar' }));
    expect(() => repo.insert(baseHabit({ name: 'meditar' }))).toThrow(/UNIQUE/);
  });

  it('list(active) excludes archived', () => {
    const id1 = repo.insert(baseHabit({ name: 'a' }));
    repo.insert(baseHabit({ name: 'b' }));
    repo.archive(id1, 1_700_000_001_000);
    expect(repo.list('active').map((h) => h.name)).toEqual(['b']);
  });

  it('list(archived) returns only archived', () => {
    const id = repo.insert(baseHabit({ name: 'x' }));
    repo.archive(id, 1_700_000_001_000);
    expect(repo.list('archived').map((h) => h.name)).toEqual(['x']);
  });

  it('list(all) returns both', () => {
    repo.insert(baseHabit({ name: 'a' }));
    const id = repo.insert(baseHabit({ name: 'b' }));
    repo.archive(id, 1_700_000_001_000);
    expect(
      repo
        .list('all')
        .map((h) => h.name)
        .sort(),
    ).toEqual(['a', 'b']);
  });

  it('findByName matches case-insensitive substring', () => {
    repo.insert(baseHabit({ name: 'Meditar Diariamente' }));
    expect(repo.findByName('meditar')?.name).toBe('Meditar Diariamente');
    expect(repo.findByName('diaria')?.name).toBe('Meditar Diariamente');
    expect(repo.findByName('foo')).toBeNull();
  });

  it('update changes fields atomically', () => {
    const id = repo.insert(baseHabit());
    repo.update(id, { target: 15, unit: 'min' });
    expect(repo.findById(id)?.target).toBe(15);
  });

  it('setReminderScheduleId links to FK', () => {
    const id = repo.insert(baseHabit());
    const scheduledRepo = new ScheduledMessageRepo(db);
    const schedId = scheduledRepo.insert({
      chatId: 'tg:1',
      title: 'lembrete',
      kind: 'agent',
      payload: 'x',
      recurrence: '0 17 * * *',
      timezone: 'America/Sao_Paulo',
      nextFireAt: 1_900_000_000_000,
      lastFiredAt: null,
      paused: 0,
      createdAt: 1_700_000_000_000,
      createdCorrelationId: 'c1',
    });
    repo.setReminderScheduleId(id, schedId);
    expect(repo.findById(id)?.reminderScheduleId).toBe(schedId);
    repo.setReminderScheduleId(id, null);
    expect(repo.findById(id)?.reminderScheduleId).toBeNull();
  });

  it('archive sets archivedAt; unarchive clears', () => {
    const id = repo.insert(baseHabit());
    repo.archive(id, 1_700_000_002_000);
    expect(repo.findById(id)?.archivedAt).toBe(1_700_000_002_000);
    repo.unarchive(id);
    expect(repo.findById(id)?.archivedAt).toBeNull();
  });

  it('FK ON DELETE SET NULL cleans reminder_schedule_id when scheduled-message is removed', () => {
    const scheduledRepo = new ScheduledMessageRepo(db);
    const schedId = scheduledRepo.insert({
      chatId: 'tg:1',
      title: 'x',
      kind: 'agent',
      payload: 'y',
      recurrence: '0 17 * * *',
      timezone: 'America/Sao_Paulo',
      nextFireAt: 1_900_000_000_000,
      lastFiredAt: null,
      paused: 0,
      createdAt: 1_700_000_000_000,
      createdCorrelationId: 'c1',
    });
    const hid = repo.insert(baseHabit({ reminderScheduleId: schedId }));
    scheduledRepo.delete(schedId);
    expect(repo.findById(hid)?.reminderScheduleId).toBeNull();
  });
});
