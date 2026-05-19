import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Db, HabitLogRepo, HabitRepo, openDatabase, runMigrations } from '@whis/storage';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildHabitToolHandlers, createHabitsMcpServer, type HabitToolHandlers } from './tools';

const TZ = 'America/Sao_Paulo';
const TODAY_LOCAL = '2026-05-18';
// 2026-05-18 12:00 UTC = 09:00 in Sao_Paulo (UTC-3) — well after midnight.
let clockMs = Date.UTC(2026, 4, 18, 12, 0, 0);

function newHandlers(deps?: { dashboardPath?: string }): {
  db: Db;
  habits: HabitRepo;
  logs: HabitLogRepo;
  h: HabitToolHandlers;
} {
  const db = openDatabase(':memory:');
  runMigrations(db);
  const habits = new HabitRepo(db);
  const logs = new HabitLogRepo(db);
  const h = buildHabitToolHandlers({
    habits,
    logs,
    clock: () => clockMs,
    timezone: TZ,
    dashboardPath: deps?.dashboardPath ?? '/tmp/test-dashboard.md',
  });
  return { db, habits, logs, h };
}

describe('habit tools — reads', () => {
  beforeEach(() => {
    clockMs = Date.UTC(2026, 4, 18, 12, 0, 0);
  });

  it('habit_list returns empty when no habits', async () => {
    const { h } = newHandlers();
    const r = await h.habit_list({});
    expect(r.entries).toEqual([]);
  });

  it('habit_list returns active habits with shape', async () => {
    const { habits, h } = newHandlers();
    habits.insert({
      name: 'meditar',
      kind: 'duration',
      unit: 'min',
      target: 10,
      cadence: 'daily',
      targetPerPeriod: null,
      daysOfWeek: null,
      reminderScheduleId: null,
      createdAt: clockMs,
      archivedAt: null,
    });
    const r = await h.habit_list({});
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]).toMatchObject({ name: 'meditar', kind: 'duration', target: 10 });
  });

  it('habit_list filter=archived excludes active', async () => {
    const { habits, h } = newHandlers();
    const id = habits.insert({
      name: 'old',
      kind: 'binary',
      unit: null,
      target: null,
      cadence: 'daily',
      targetPerPeriod: null,
      daysOfWeek: null,
      reminderScheduleId: null,
      createdAt: clockMs,
      archivedAt: null,
    });
    habits.archive(id, clockMs);
    expect((await h.habit_list({ filter: 'active' })).entries).toHaveLength(0);
    expect((await h.habit_list({ filter: 'archived' })).entries).toHaveLength(1);
  });

  it('habit_status returns done/pending/off per habit for today', async () => {
    const { habits, logs, h } = newHandlers();
    const m = habits.insert({
      name: 'meditar',
      kind: 'duration',
      unit: 'min',
      target: 10,
      cadence: 'daily',
      targetPerPeriod: null,
      daysOfWeek: null,
      reminderScheduleId: null,
      createdAt: clockMs,
      archivedAt: null,
    });
    habits.insert({
      name: 'ler',
      kind: 'binary',
      unit: null,
      target: null,
      cadence: 'daily',
      targetPerPeriod: null,
      daysOfWeek: null,
      reminderScheduleId: null,
      createdAt: clockMs,
      archivedAt: null,
    });
    logs.insert({
      habitId: m,
      value: 10,
      loggedAt: clockMs,
      forDate: TODAY_LOCAL,
      createdAt: clockMs,
      correlationId: 'c',
    });
    const r = await h.habit_status({});
    expect(r.date).toBe(TODAY_LOCAL);
    expect(r.today).toContainEqual(expect.objectContaining({ name: 'meditar', status: 'done' }));
    expect(r.today).toContainEqual(expect.objectContaining({ name: 'ler', status: 'pending' }));
  });

  it('habit_today_pending lists only pending habits', async () => {
    const { habits, h } = newHandlers();
    habits.insert({
      name: 'ler',
      kind: 'binary',
      unit: null,
      target: null,
      cadence: 'daily',
      targetPerPeriod: null,
      daysOfWeek: null,
      reminderScheduleId: null,
      createdAt: clockMs,
      archivedAt: null,
    });
    const r = await h.habit_today_pending({});
    expect(r.pending.map((p) => p.name)).toEqual(['ler']);
  });

  it('habit_today_status returns single-habit done/pending', async () => {
    const { habits, logs, h } = newHandlers();
    const id = habits.insert({
      name: 'exercitar',
      kind: 'binary',
      unit: null,
      target: null,
      cadence: 'daily',
      targetPerPeriod: null,
      daysOfWeek: null,
      reminderScheduleId: null,
      createdAt: clockMs,
      archivedAt: null,
    });
    expect((await h.habit_today_status({ habitId: id })).status).toBe('pending');
    logs.insert({
      habitId: id,
      value: 1,
      loggedAt: clockMs,
      forDate: TODAY_LOCAL,
      createdAt: clockMs,
      correlationId: 'c',
    });
    expect((await h.habit_today_status({ habitId: id })).status).toBe('done');
  });

  it('habit_today_status throws on unknown habit id', async () => {
    const { h } = newHandlers();
    await expect(h.habit_today_status({ habitId: 9999 })).rejects.toThrow(/not found/);
  });
});

describe('habit tools — writes leves', () => {
  let tmpDir: string;
  let dashboardPath: string;

  beforeEach(() => {
    clockMs = Date.UTC(2026, 4, 18, 12, 0, 0);
    tmpDir = mkdtempSync(join(tmpdir(), 'whis-habit-'));
    dashboardPath = join(tmpDir, 'habits', 'dashboard.md');
  });

  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it('habit_log inserts row and returns streak', async () => {
    const { habits, logs, h } = newHandlers({ dashboardPath });
    const id = habits.insert({
      name: 'meditar',
      kind: 'duration',
      unit: 'min',
      target: 10,
      cadence: 'daily',
      targetPerPeriod: null,
      daysOfWeek: null,
      reminderScheduleId: null,
      createdAt: clockMs,
      archivedAt: null,
    });
    const r = await h.habit_log({ habitId: id, value: 12, correlationId: 'c1' });
    expect(r.streak).toBe(1);
    expect(r.forDate).toBe(TODAY_LOCAL);
    expect(logs.findLast(id, 5)).toHaveLength(1);
  });

  it('habit_log accepts retroactive at=YYYY-MM-DD', async () => {
    const { habits, h } = newHandlers({ dashboardPath });
    const id = habits.insert({
      name: 'meditar',
      kind: 'duration',
      unit: 'min',
      target: 10,
      cadence: 'daily',
      targetPerPeriod: null,
      daysOfWeek: null,
      reminderScheduleId: null,
      createdAt: clockMs,
      archivedAt: null,
    });
    const r = await h.habit_log({ habitId: id, value: 8, at: '2026-05-17', correlationId: 'c1' });
    expect(r.forDate).toBe('2026-05-17');
  });

  it('habit_log throws on unknown habit', async () => {
    const { h } = newHandlers({ dashboardPath });
    await expect(h.habit_log({ habitId: 9999, value: 1, correlationId: 'c' })).rejects.toThrow(
      /not found/,
    );
  });

  it('habit_log throws on archived habit', async () => {
    const { habits, h } = newHandlers({ dashboardPath });
    const id = habits.insert({
      name: 'x',
      kind: 'binary',
      unit: null,
      target: null,
      cadence: 'daily',
      targetPerPeriod: null,
      daysOfWeek: null,
      reminderScheduleId: null,
      createdAt: clockMs,
      archivedAt: null,
    });
    habits.archive(id, clockMs);
    await expect(h.habit_log({ habitId: id, value: 1, correlationId: 'c' })).rejects.toThrow(
      /archived/,
    );
  });

  it('habit_log_undo removes last log within window', async () => {
    const { habits, logs, h } = newHandlers({ dashboardPath });
    const id = habits.insert({
      name: 'x',
      kind: 'binary',
      unit: null,
      target: null,
      cadence: 'daily',
      targetPerPeriod: null,
      daysOfWeek: null,
      reminderScheduleId: null,
      createdAt: clockMs,
      archivedAt: null,
    });
    await h.habit_log({ habitId: id, value: 1, correlationId: 'c' });
    const r = await h.habit_log_undo({ habitId: id });
    expect(r.undone).toBe(true);
    expect(logs.findLast(id, 5)).toHaveLength(0);
  });

  it('habit_log_undo fails outside 5min window', async () => {
    const { habits, h } = newHandlers({ dashboardPath });
    const id = habits.insert({
      name: 'x',
      kind: 'binary',
      unit: null,
      target: null,
      cadence: 'daily',
      targetPerPeriod: null,
      daysOfWeek: null,
      reminderScheduleId: null,
      createdAt: clockMs,
      archivedAt: null,
    });
    await h.habit_log({ habitId: id, value: 1, correlationId: 'c' });
    clockMs += 6 * 60 * 1000;
    const r = await h.habit_log_undo({ habitId: id });
    expect(r.undone).toBe(false);
  });

  it('habit_render_dashboard writes markdown to dashboardPath', async () => {
    const { habits, h } = newHandlers({ dashboardPath });
    habits.insert({
      name: 'meditar',
      kind: 'duration',
      unit: 'min',
      target: 10,
      cadence: 'daily',
      targetPerPeriod: null,
      daysOfWeek: null,
      reminderScheduleId: null,
      createdAt: clockMs,
      archivedAt: null,
    });
    const r = await h.habit_render_dashboard({});
    expect(r.path).toBe(dashboardPath);
    expect(r.sizeBytes).toBeGreaterThan(0);
    const content = readFileSync(dashboardPath, 'utf8');
    expect(content).toContain('## meditar');
  });

  it('habit_render_dashboard creates parent dir if missing', async () => {
    const { h } = newHandlers({ dashboardPath });
    const r = await h.habit_render_dashboard({});
    expect(r.path).toBe(dashboardPath);
  });
});

describe('habit tools — writes destrutivos', () => {
  beforeEach(() => {
    clockMs = Date.UTC(2026, 4, 18, 12, 0, 0);
  });

  it('habit_create binary daily', async () => {
    const { habits, h } = newHandlers();
    const r = await h.habit_create({
      name: 'malhação',
      kind: 'binary',
      cadence: 'daily',
      correlationId: 'c1',
    });
    expect(r.id).toBeGreaterThan(0);
    expect(habits.findById(r.id)?.kind).toBe('binary');
  });

  it('habit_create quantity with unit/target', async () => {
    const { habits, h } = newHandlers();
    const r = await h.habit_create({
      name: 'água',
      kind: 'quantity',
      cadence: 'daily',
      unit: 'ml',
      target: 2000,
      correlationId: 'c1',
    });
    expect(habits.findById(r.id)?.target).toBe(2000);
    expect(habits.findById(r.id)?.unit).toBe('ml');
  });

  it('habit_create weekly with targetPerPeriod', async () => {
    const { habits, h } = newHandlers();
    const r = await h.habit_create({
      name: 'malhação',
      kind: 'binary',
      cadence: 'weekly',
      targetPerPeriod: 3,
      correlationId: 'c1',
    });
    expect(habits.findById(r.id)?.targetPerPeriod).toBe(3);
  });

  it('habit_create custom_days normalizes daysOfWeek to CSV sorted', async () => {
    const { habits, h } = newHandlers();
    const r = await h.habit_create({
      name: 'corrida',
      kind: 'binary',
      cadence: 'custom_days',
      daysOfWeek: [5, 1, 3],
      correlationId: 'c1',
    });
    expect(habits.findById(r.id)?.daysOfWeek).toBe('1,3,5');
  });

  it('habit_create rejects duplicate name', async () => {
    const { h } = newHandlers();
    await h.habit_create({
      name: 'meditar',
      kind: 'binary',
      cadence: 'daily',
      correlationId: 'c1',
    });
    await expect(
      h.habit_create({
        name: 'meditar',
        kind: 'binary',
        cadence: 'daily',
        correlationId: 'c2',
      }),
    ).rejects.toThrow(/UNIQUE/i);
  });

  it('habit_create rejects quantity without target', async () => {
    const { h } = newHandlers();
    await expect(
      h.habit_create({ name: 'x', kind: 'quantity', cadence: 'daily', correlationId: 'c' }),
    ).rejects.toThrow(/target/);
  });

  it('habit_create rejects custom_days without daysOfWeek', async () => {
    const { h } = newHandlers();
    await expect(
      h.habit_create({ name: 'x', kind: 'binary', cadence: 'custom_days', correlationId: 'c' }),
    ).rejects.toThrow(/daysOfWeek/);
  });

  it('habit_create rejects weekly without targetPerPeriod', async () => {
    const { h } = newHandlers();
    await expect(
      h.habit_create({ name: 'x', kind: 'binary', cadence: 'weekly', correlationId: 'c' }),
    ).rejects.toThrow(/targetPerPeriod/);
  });

  it('habit_edit changes target', async () => {
    const { habits, h } = newHandlers();
    const { id } = await h.habit_create({
      name: 'meditar',
      kind: 'duration',
      unit: 'min',
      target: 10,
      cadence: 'daily',
      correlationId: 'c1',
    });
    await h.habit_edit({ id, fields: { target: 15 } });
    expect(habits.findById(id)?.target).toBe(15);
  });

  it('habit_archive sets archivedAt', async () => {
    const { habits, h } = newHandlers();
    const { id } = await h.habit_create({
      name: 'flexões',
      kind: 'quantity',
      target: 30,
      cadence: 'daily',
      correlationId: 'c1',
    });
    const r = await h.habit_archive({ id });
    expect(r.archivedAt).toBeGreaterThan(0);
    expect(habits.findById(id)?.archivedAt).not.toBeNull();
  });

  it('habit_unarchive clears archivedAt', async () => {
    const { habits, h } = newHandlers();
    const { id } = await h.habit_create({
      name: 'flexões',
      kind: 'binary',
      cadence: 'daily',
      correlationId: 'c1',
    });
    await h.habit_archive({ id });
    await h.habit_unarchive({ id });
    expect(habits.findById(id)?.archivedAt).toBeNull();
  });
});

describe('createHabitsMcpServer', () => {
  it('returns server without throwing', () => {
    const db = openDatabase(':memory:');
    runMigrations(db);
    const server = createHabitsMcpServer({
      habits: new HabitRepo(db),
      logs: new HabitLogRepo(db),
      timezone: TZ,
      dashboardPath: '/tmp/x.md',
    });
    expect(server).toBeDefined();
  });
});
