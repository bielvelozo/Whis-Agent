import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ScheduledMessageRepo } from '@whis/storage';
import { z } from 'zod';
import { computeNextFire, validateCron } from '@/scheduler/cron';

interface ToolDeps {
  repo: ScheduledMessageRepo;
  ownerChatId: string;
  /** Test seam — defaults to Date.now() */
  clock?: () => number;
}

const DEFAULT_TZ = 'America/Sao_Paulo';

interface ListedEntry {
  id: number;
  title: string;
  kind: 'literal' | 'agent';
  recurrence: string | null;
  nextFireAtIso: string;
  paused: boolean;
  payloadPreview: string;
}

export interface ToolHandlers {
  schedule_list: (input: {
    filter?: 'active' | 'paused' | 'all';
    limit?: number;
  }) => Promise<{ entries: ListedEntry[] }>;
  schedule_create: (input: {
    title: string;
    kind: 'literal' | 'agent';
    payload: string;
    when: string;
    timezone?: string;
    correlationId: string;
    callerUserId?: string;
  }) => Promise<{ id: number; title: string; nextFireAtIso: string }>;
  schedule_edit: (input: {
    id: number;
    fields: { title?: string; payload?: string; when?: string; timezone?: string };
  }) => Promise<{ id: number; title: string; nextFireAtIso: string }>;
  schedule_cancel: (input: { id: number }) => Promise<{ ok: true; deletedTitle: string }>;
  schedule_pause: (input: { id: number }) => Promise<{ ok: true; paused: true }>;
  schedule_resume: (input: {
    id: number;
  }) => Promise<{ ok: true; paused: false; nextFireAtIso: string }>;
}

export function buildToolHandlers(deps: ToolDeps): ToolHandlers {
  const clock = deps.clock ?? (() => Date.now());

  function previewPayload(p: string): string {
    return p.length > 80 ? `${p.slice(0, 77)}...` : p;
  }

  function toIso(ms: number): string {
    return new Date(ms).toISOString();
  }

  function resolveWhen(
    when: string,
    timezone: string,
  ): { nextFireAt: number; recurrence: string | null } {
    if (validateCron(when)) {
      const next = computeNextFire(when, timezone, clock());
      return { nextFireAt: next, recurrence: when };
    }
    const t = Date.parse(when);
    if (Number.isNaN(t)) {
      throw new Error(`invalid when: not a valid ISO datetime nor cron expression: ${when}`);
    }
    if (t <= clock()) {
      throw new Error(`when is in the past (${when}), cannot schedule`);
    }
    return { nextFireAt: t, recurrence: null };
  }

  return {
    schedule_list: async (input) => {
      const filter = input.filter ?? 'active';
      const limit = input.limit ?? 20;
      const rows = deps.repo.list(filter, limit);
      return {
        entries: rows.map((r) => ({
          id: r.id,
          title: r.title,
          kind: r.kind,
          recurrence: r.recurrence,
          nextFireAtIso: toIso(r.nextFireAt),
          paused: r.paused === 1,
          payloadPreview: previewPayload(r.payload),
        })),
      };
    },

    schedule_create: async (input) => {
      if (input.callerUserId === 'system:scheduler') {
        throw new Error('schedule_create blocked: callerUserId=system:scheduler (loop guard)');
      }
      const tz = input.timezone ?? DEFAULT_TZ;
      const { nextFireAt, recurrence } = resolveWhen(input.when, tz);
      const id = deps.repo.insert({
        chatId: deps.ownerChatId,
        title: input.title,
        kind: input.kind,
        payload: input.payload,
        recurrence,
        timezone: tz,
        nextFireAt,
        lastFiredAt: null,
        paused: 0,
        createdAt: clock(),
        createdCorrelationId: input.correlationId,
      });
      return { id, title: input.title, nextFireAtIso: toIso(nextFireAt) };
    },

    schedule_edit: async (input) => {
      const existing = deps.repo.findById(input.id);
      if (!existing) throw new Error(`schedule not found: id=${input.id}`);
      const fields = input.fields;
      if (
        fields.title === undefined &&
        fields.payload === undefined &&
        fields.when === undefined &&
        fields.timezone === undefined
      ) {
        throw new Error('no fields to update (empty fields object)');
      }
      const update: {
        title?: string;
        payload?: string;
        nextFireAt?: number;
        recurrence?: string | null;
        timezone?: string;
      } = {};
      if (fields.title !== undefined) update.title = fields.title;
      if (fields.payload !== undefined) update.payload = fields.payload;
      if (fields.timezone !== undefined) update.timezone = fields.timezone;
      if (fields.when !== undefined) {
        const tz = fields.timezone ?? existing.timezone;
        const { nextFireAt, recurrence } = resolveWhen(fields.when, tz);
        update.nextFireAt = nextFireAt;
        update.recurrence = recurrence;
      }
      deps.repo.update(input.id, update);
      const after = deps.repo.findById(input.id);
      if (!after) throw new Error(`schedule disappeared after update: id=${input.id}`);
      return { id: input.id, title: after.title, nextFireAtIso: toIso(after.nextFireAt) };
    },

    schedule_cancel: async (input) => {
      const existing = deps.repo.findById(input.id);
      if (!existing) throw new Error(`schedule not found: id=${input.id}`);
      deps.repo.delete(input.id);
      return { ok: true, deletedTitle: existing.title };
    },

    schedule_pause: async (input) => {
      const existing = deps.repo.findById(input.id);
      if (!existing) throw new Error(`schedule not found: id=${input.id}`);
      deps.repo.pause(input.id);
      return { ok: true, paused: true };
    },

    schedule_resume: async (input) => {
      const existing = deps.repo.findById(input.id);
      if (!existing) throw new Error(`schedule not found: id=${input.id}`);
      let next = existing.nextFireAt;
      if (existing.recurrence !== null) {
        next = computeNextFire(existing.recurrence, existing.timezone, clock());
      }
      deps.repo.resume(input.id, next);
      return { ok: true, paused: false, nextFireAtIso: toIso(next) };
    },
  };
}

function asTextResult(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

/**
 * Build the in-process MCP server exposing all 6 scheduled-messages tools.
 * Returned object is passed verbatim to ClaudeCodeBackend's `inProcessMcpServers` slot.
 */
export function createScheduledMessagesMcpServer(deps: ToolDeps) {
  const handlers = buildToolHandlers(deps);

  return createSdkMcpServer({
    name: 'scheduled-messages',
    version: '1.0.0',
    tools: [
      tool(
        'schedule_list',
        'List scheduled messages. Returns active by default.',
        {
          filter: z.enum(['active', 'paused', 'all']).optional(),
          limit: z.number().int().positive().max(100).optional(),
        },
        async (args) => asTextResult(await handlers.schedule_list(args)),
      ),
      tool(
        'schedule_create',
        'Create a new scheduled message. `when` is ISO 8601 absolute (e.g. "2026-04-27T09:00:00-03:00") OR 5-field cron string (e.g. "0 8 * * *").',
        {
          title: z.string().min(1),
          kind: z.enum(['literal', 'agent']),
          payload: z.string().min(1),
          when: z.string().min(1),
          timezone: z.string().optional(),
          correlationId: z.string(),
          callerUserId: z.string().optional(),
        },
        async (args) => asTextResult(await handlers.schedule_create(args)),
      ),
      tool(
        'schedule_edit',
        'Edit an existing scheduled message. Supply only the fields to change.',
        {
          id: z.number().int().positive(),
          fields: z.object({
            title: z.string().optional(),
            payload: z.string().optional(),
            when: z.string().optional(),
            timezone: z.string().optional(),
          }),
        },
        async (args) => asTextResult(await handlers.schedule_edit(args)),
      ),
      tool(
        'schedule_cancel',
        'Cancel (delete) a scheduled message.',
        { id: z.number().int().positive() },
        async (args) => asTextResult(await handlers.schedule_cancel(args)),
      ),
      tool(
        'schedule_pause',
        'Pause a scheduled message (recurrent: stops firing until resumed).',
        { id: z.number().int().positive() },
        async (args) => asTextResult(await handlers.schedule_pause(args)),
      ),
      tool(
        'schedule_resume',
        'Resume a paused scheduled message. Recurrent ones get next_fire_at recomputed.',
        { id: z.number().int().positive() },
        async (args) => asTextResult(await handlers.schedule_resume(args)),
      ),
    ],
  });
}
