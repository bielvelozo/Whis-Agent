import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { HabitCadence, HabitKind, HabitLogRepo, HabitRecord, HabitRepo } from '@whis/storage';
import { z } from 'zod';
import { renderDashboard } from './dashboard.js';
import { computeStreak, isPendingForDate } from './stats.js';

const UNDO_WINDOW_MS = 5 * 60 * 1000;

export interface HabitToolDeps {
  habits: HabitRepo;
  logs: HabitLogRepo;
  /** Test seam */
  clock?: () => number;
  timezone: string;
  /** Absolute path where habit_render_dashboard writes markdown */
  dashboardPath: string;
}

interface HabitListed {
  id: number;
  name: string;
  kind: HabitKind;
  unit: string | null;
  target: number | null;
  cadence: HabitCadence;
  targetPerPeriod: number | null;
  daysOfWeek: string | null;
  reminderScheduleId: number | null;
  archived: boolean;
}

interface TodayEntry {
  id: number;
  name: string;
  status: 'done' | 'pending' | 'off';
  streak: number;
}

export interface HabitToolHandlers {
  habit_list: (input: {
    filter?: 'active' | 'archived' | 'all';
  }) => Promise<{ entries: HabitListed[] }>;
  habit_status: (input: Record<string, never>) => Promise<{ today: TodayEntry[]; date: string }>;
  habit_today_pending: (
    input: Record<string, never>,
  ) => Promise<{ pending: { id: number; name: string }[]; date: string }>;
  habit_today_status: (input: { habitId: number }) => Promise<{
    status: 'done' | 'pending' | 'off';
    name: string;
    streak: number;
    date: string;
  }>;
  habit_log: (input: {
    habitId: number;
    value?: number;
    at?: string;
    correlationId: string;
  }) => Promise<{ id: number; forDate: string; streak: number }>;
  habit_log_undo: (input: { habitId: number }) => Promise<{
    undone: boolean;
    deletedLog?: { id: number; value: number; forDate: string };
  }>;
  habit_render_dashboard: (
    input: Record<string, never>,
  ) => Promise<{ path: string; sizeBytes: number }>;
  habit_create: (input: {
    name: string;
    kind: HabitKind;
    cadence: HabitCadence;
    unit?: string | null;
    target?: number | null;
    targetPerPeriod?: number | null;
    daysOfWeek?: number[] | null;
    correlationId: string;
  }) => Promise<{ id: number; name: string }>;
  habit_edit: (input: {
    id: number;
    fields: {
      name?: string;
      unit?: string | null;
      target?: number | null;
      cadence?: HabitCadence;
      targetPerPeriod?: number | null;
      daysOfWeek?: number[] | null;
    };
  }) => Promise<{ id: number }>;
  habit_archive: (input: { id: number }) => Promise<{ id: number; archivedAt: number }>;
  habit_unarchive: (input: { id: number }) => Promise<{ id: number }>;
}

function localDateString(ms: number, tz: string): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(new Date(ms));
}

function statusForHabit(
  habit: HabitRecord,
  logsForHabit: ReturnType<HabitLogRepo['findByHabitAndDateRange']>,
  date: string,
): 'done' | 'pending' | 'off' {
  const todays = logsForHabit.filter((l) => l.forDate === date);
  const pending = isPendingForDate(habit, logsForHabit, date);
  if (todays.length === 0 && !pending) return 'off';
  return pending ? 'pending' : 'done';
}

export function buildHabitToolHandlers(deps: HabitToolDeps): HabitToolHandlers {
  const clock = deps.clock ?? (() => Date.now());
  const today = () => localDateString(clock(), deps.timezone);

  function normalizeDaysOfWeek(days: number[] | null | undefined): string | null | undefined {
    if (days === undefined) return undefined;
    if (days === null) return null;
    for (const d of days) {
      if (d < 1 || d > 7) throw new Error(`daysOfWeek must be 1-7, got ${d}`);
    }
    return days
      .slice()
      .sort((a, b) => a - b)
      .join(',');
  }

  return {
    async habit_list({ filter = 'active' }) {
      const list = deps.habits.list(filter);
      return {
        entries: list.map((h) => ({
          id: h.id,
          name: h.name,
          kind: h.kind,
          unit: h.unit,
          target: h.target,
          cadence: h.cadence,
          targetPerPeriod: h.targetPerPeriod,
          daysOfWeek: h.daysOfWeek,
          reminderScheduleId: h.reminderScheduleId,
          archived: h.archivedAt !== null,
        })),
      };
    },

    async habit_status() {
      const date = today();
      const active = deps.habits.list('active');
      const items: TodayEntry[] = active.map((h) => {
        const logs = deps.logs.findByHabitAndDateRange(h.id, '0000-01-01', date);
        return {
          id: h.id,
          name: h.name,
          status: statusForHabit(h, logs, date),
          streak: computeStreak(h, logs, date),
        };
      });
      return { today: items, date };
    },

    async habit_today_pending() {
      const date = today();
      const active = deps.habits.list('active');
      const pending = active
        .filter((h) => {
          const logs = deps.logs.findByHabitAndDateRange(h.id, '0000-01-01', date);
          return isPendingForDate(h, logs, date);
        })
        .map((h) => ({ id: h.id, name: h.name }));
      return { pending, date };
    },

    async habit_today_status({ habitId }) {
      const habit = deps.habits.findById(habitId);
      if (!habit) throw new Error(`habit not found: ${habitId}`);
      const date = today();
      const logs = deps.logs.findByHabitAndDateRange(habit.id, '0000-01-01', date);
      return {
        status: statusForHabit(habit, logs, date),
        name: habit.name,
        streak: computeStreak(habit, logs, date),
        date,
      };
    },

    async habit_log({ habitId, value, at, correlationId }) {
      const habit = deps.habits.findById(habitId);
      if (!habit) throw new Error(`habit not found: ${habitId}`);
      if (habit.archivedAt !== null) throw new Error(`habit is archived: ${habit.name}`);
      const v = value ?? 1;
      const now = clock();
      const forDate = at ?? localDateString(now, deps.timezone);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(forDate)) {
        throw new Error(`invalid date format (expected YYYY-MM-DD): ${forDate}`);
      }
      const id = deps.logs.insert({
        habitId: habit.id,
        value: v,
        loggedAt: now,
        forDate,
        createdAt: now,
        correlationId,
      });
      const date = localDateString(now, deps.timezone);
      const allLogs = deps.logs.findByHabitAndDateRange(habit.id, '0000-01-01', date);
      return { id, forDate, streak: computeStreak(habit, allLogs, date) };
    },

    async habit_log_undo({ habitId }) {
      const deleted = deps.logs.deleteLast(habitId, clock(), UNDO_WINDOW_MS);
      if (!deleted) return { undone: false };
      return {
        undone: true,
        deletedLog: { id: deleted.id, value: deleted.value, forDate: deleted.forDate },
      };
    },

    async habit_render_dashboard() {
      const habits = deps.habits.list('active');
      const date = today();
      const since = (() => {
        const d = new Date(`${date}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() - 29);
        return d.toISOString().slice(0, 10);
      })();
      const allLogs = habits.flatMap((h) => deps.logs.findByHabitAndDateRange(h.id, since, date));
      const md = renderDashboard({ habits, logs: allLogs, asOf: date });
      mkdirSync(dirname(deps.dashboardPath), { recursive: true });
      writeFileSync(deps.dashboardPath, md, 'utf8');
      return { path: deps.dashboardPath, sizeBytes: Buffer.byteLength(md, 'utf8') };
    },

    async habit_create({
      name,
      kind,
      cadence,
      unit,
      target,
      targetPerPeriod,
      daysOfWeek,
      correlationId: _correlationId,
    }) {
      if (kind !== 'binary' && (target === undefined || target === null)) {
        throw new Error('target is required for quantity/duration habits');
      }
      if (cadence === 'weekly' && (targetPerPeriod === undefined || targetPerPeriod === null)) {
        throw new Error('targetPerPeriod is required for weekly cadence');
      }
      if (cadence === 'custom_days' && (!daysOfWeek || daysOfWeek.length === 0)) {
        throw new Error('daysOfWeek is required for custom_days cadence');
      }
      const normalized = normalizeDaysOfWeek(daysOfWeek);
      const now = clock();
      const id = deps.habits.insert({
        name,
        kind,
        unit: unit ?? null,
        target: target ?? null,
        cadence,
        targetPerPeriod: targetPerPeriod ?? null,
        daysOfWeek: normalized ?? null,
        reminderScheduleId: null,
        createdAt: now,
        archivedAt: null,
      });
      return { id, name };
    },

    async habit_edit({ id, fields }) {
      const existing = deps.habits.findById(id);
      if (!existing) throw new Error(`habit not found: ${id}`);
      const days = normalizeDaysOfWeek(fields.daysOfWeek);
      deps.habits.update(id, {
        name: fields.name,
        unit: fields.unit,
        target: fields.target,
        cadence: fields.cadence,
        targetPerPeriod: fields.targetPerPeriod,
        daysOfWeek: days,
      });
      return { id };
    },

    async habit_archive({ id }) {
      if (!deps.habits.findById(id)) throw new Error(`habit not found: ${id}`);
      const at = clock();
      deps.habits.archive(id, at);
      return { id, archivedAt: at };
    },

    async habit_unarchive({ id }) {
      if (!deps.habits.findById(id)) throw new Error(`habit not found: ${id}`);
      deps.habits.unarchive(id);
      return { id };
    },
  };
}

function asTextResult(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

const cadenceEnum = z.enum(['daily', 'weekly', 'custom_days']);
const kindEnum = z.enum(['binary', 'quantity', 'duration']);

/**
 * Build the in-process MCP server exposing all 10 habits tools.
 * Returned object is passed verbatim to ClaudeCodeBackend's `inProcessMcpServers` slot.
 */
export function createHabitsMcpServer(deps: HabitToolDeps) {
  const handlers = buildHabitToolHandlers(deps);

  return createSdkMcpServer({
    name: 'habits',
    version: '1.0.0',
    tools: [
      tool(
        'habit_list',
        'List habits (default filter=active).',
        { filter: z.enum(['active', 'archived', 'all']).optional() },
        async (args) => asTextResult(await handlers.habit_list(args)),
      ),
      tool(
        'habit_status',
        'Return today status (done/pending/off) for all active habits with streak.',
        {},
        async (args) => asTextResult(await handlers.habit_status(args)),
      ),
      tool(
        'habit_today_pending',
        'List habits pending today (expected today, not yet met).',
        {},
        async (args) => asTextResult(await handlers.habit_today_pending(args)),
      ),
      tool(
        'habit_today_status',
        'Single-habit today status by id. Used by pre-emptive reminders to decide between firing and silencing.',
        { habitId: z.number().int().positive() },
        async (args) => asTextResult(await handlers.habit_today_status(args)),
      ),
      tool(
        'habit_log',
        'Log a habit. value defaults to 1 (binary). at defaults to today (YYYY-MM-DD, local timezone).',
        {
          habitId: z.number().int().positive(),
          value: z.number().positive().optional(),
          at: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional(),
          correlationId: z.string(),
        },
        async (args) => asTextResult(await handlers.habit_log(args)),
      ),
      tool(
        'habit_log_undo',
        'Undo the last log for a habit if within 5 minutes.',
        { habitId: z.number().int().positive() },
        async (args) => asTextResult(await handlers.habit_log_undo(args)),
      ),
      tool(
        'habit_render_dashboard',
        'Render markdown dashboard to context/habits/dashboard.md (overwrite).',
        {},
        async (args) => asTextResult(await handlers.habit_render_dashboard(args)),
      ),
      tool(
        'habit_create',
        'Create a new habit. binary/quantity/duration + daily/weekly/custom_days.',
        {
          name: z.string().min(1),
          kind: kindEnum,
          cadence: cadenceEnum,
          unit: z.string().nullable().optional(),
          target: z.number().positive().nullable().optional(),
          targetPerPeriod: z.number().int().positive().nullable().optional(),
          daysOfWeek: z.array(z.number().int().min(1).max(7)).nullable().optional(),
          correlationId: z.string(),
        },
        async (args) => asTextResult(await handlers.habit_create(args)),
      ),
      tool(
        'habit_edit',
        'Edit habit fields.',
        {
          id: z.number().int().positive(),
          fields: z.object({
            name: z.string().min(1).optional(),
            unit: z.string().nullable().optional(),
            target: z.number().positive().nullable().optional(),
            cadence: cadenceEnum.optional(),
            targetPerPeriod: z.number().int().positive().nullable().optional(),
            daysOfWeek: z.array(z.number().int().min(1).max(7)).nullable().optional(),
          }),
        },
        async (args) => asTextResult(await handlers.habit_edit(args)),
      ),
      tool(
        'habit_archive',
        'Archive habit (keeps history; hides from status). Reminder cascade is orchestrated by SKILL.md, not this tool.',
        { id: z.number().int().positive() },
        async (args) => asTextResult(await handlers.habit_archive(args)),
      ),
      tool(
        'habit_unarchive',
        'Unarchive habit.',
        { id: z.number().int().positive() },
        async (args) => asTextResult(await handlers.habit_unarchive(args)),
      ),
    ],
  });
}
