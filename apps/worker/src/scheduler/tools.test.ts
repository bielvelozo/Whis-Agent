import { openDatabase, runMigrations, ScheduledMessageRepo } from '@whis/storage';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildToolHandlers, type ToolHandlers } from '@/scheduler/tools';

describe('scheduled-messages tools', () => {
  let repo: ScheduledMessageRepo;
  let handlers: ToolHandlers;

  beforeEach(() => {
    const db = openDatabase(':memory:');
    runMigrations(db);
    repo = new ScheduledMessageRepo(db);
    handlers = buildToolHandlers({
      repo,
      ownerChatId: 'tg:1',
      clock: () => 1_000_000_000_000,
    });
  });

  describe('schedule_create', () => {
    it('creates one-shot literal with absolute when (ISO)', async () => {
      const out = await handlers.schedule_create({
        title: 'pão',
        kind: 'literal',
        payload: 'comprar pão',
        when: '2030-01-01T09:00:00-03:00',
        correlationId: 'cid',
      });
      expect(out.id).toBeGreaterThan(0);
      const got = repo.findById(out.id);
      expect(got?.recurrence).toBeNull();
      expect(got?.kind).toBe('literal');
    });

    it('creates recurrent agent with cron when', async () => {
      const out = await handlers.schedule_create({
        title: 'bom-dia',
        kind: 'agent',
        payload: 'manda bom dia',
        when: '0 8 * * *',
        correlationId: 'cid',
      });
      expect(out.id).toBeGreaterThan(0);
      const got = repo.findById(out.id);
      expect(got?.recurrence).toBe('0 8 * * *');
      expect(got?.nextFireAt).toBeGreaterThan(1_000_000_000_000);
    });

    it('rejects malformed cron and invalid ISO', async () => {
      await expect(
        handlers.schedule_create({
          title: 't',
          kind: 'literal',
          payload: 'p',
          when: 'gobbledygook xx',
          correlationId: 'cid',
        }),
      ).rejects.toThrow(/invalid when/i);
    });

    it('rejects ISO when in the past', async () => {
      await expect(
        handlers.schedule_create({
          title: 't',
          kind: 'literal',
          payload: 'p',
          when: '2000-01-01T00:00:00Z',
          correlationId: 'cid',
        }),
      ).rejects.toThrow(/past/i);
    });

    it('rejects when called from system:scheduler (loop guard)', async () => {
      await expect(
        handlers.schedule_create({
          title: 't',
          kind: 'literal',
          payload: 'p',
          when: '2030-01-01T00:00:00Z',
          correlationId: 'cid',
          callerUserId: 'system:scheduler',
        }),
      ).rejects.toThrow(/system:scheduler|loop/i);
    });
  });

  describe('schedule_list', () => {
    it('lists active by default', async () => {
      repo.insert({
        chatId: 'tg:1',
        title: 'a',
        kind: 'literal',
        payload: 'x',
        recurrence: null,
        timezone: 'America/Sao_Paulo',
        nextFireAt: 5_000_000_000_000,
        lastFiredAt: null,
        paused: 0,
        createdAt: 1_000_000_000_000,
        createdCorrelationId: 'c',
      });
      repo.insert({
        chatId: 'tg:1',
        title: 'b',
        kind: 'literal',
        payload: 'y',
        recurrence: null,
        timezone: 'America/Sao_Paulo',
        nextFireAt: 5_000_000_000_000,
        lastFiredAt: null,
        paused: 1,
        createdAt: 1_000_000_000_000,
        createdCorrelationId: 'c',
      });
      const out = await handlers.schedule_list({});
      expect(out.entries).toHaveLength(1);
      expect(out.entries[0].title).toBe('a');
      expect(out.entries[0].paused).toBe(false);
    });

    it('filter=all returns both', async () => {
      repo.insert({
        chatId: 'tg:1',
        title: 'a',
        kind: 'literal',
        payload: 'x',
        recurrence: null,
        timezone: 'America/Sao_Paulo',
        nextFireAt: 5_000_000_000_000,
        lastFiredAt: null,
        paused: 0,
        createdAt: 1_000_000_000_000,
        createdCorrelationId: 'c',
      });
      repo.insert({
        chatId: 'tg:1',
        title: 'b',
        kind: 'literal',
        payload: 'y',
        recurrence: null,
        timezone: 'America/Sao_Paulo',
        nextFireAt: 5_000_000_000_000,
        lastFiredAt: null,
        paused: 1,
        createdAt: 1_000_000_000_000,
        createdCorrelationId: 'c',
      });
      const out = await handlers.schedule_list({ filter: 'all' });
      expect(out.entries).toHaveLength(2);
    });

    it('truncates payload preview at 80 chars', async () => {
      const longPayload = 'x'.repeat(200);
      repo.insert({
        chatId: 'tg:1',
        title: 'long',
        kind: 'literal',
        payload: longPayload,
        recurrence: null,
        timezone: 'America/Sao_Paulo',
        nextFireAt: 5_000_000_000_000,
        lastFiredAt: null,
        paused: 0,
        createdAt: 1_000_000_000_000,
        createdCorrelationId: 'c',
      });
      const out = await handlers.schedule_list({});
      expect(out.entries[0].payloadPreview.length).toBeLessThanOrEqual(80);
      expect(out.entries[0].payloadPreview).toMatch(/\.\.\.$/);
    });
  });

  describe('schedule_cancel / pause / resume / edit', () => {
    let id: number;
    beforeEach(() => {
      id = repo.insert({
        chatId: 'tg:1',
        title: 'orig',
        kind: 'literal',
        payload: 'orig',
        recurrence: null,
        timezone: 'America/Sao_Paulo',
        nextFireAt: 5_000_000_000_000,
        lastFiredAt: null,
        paused: 0,
        createdAt: 1_000_000_000_000,
        createdCorrelationId: 'c',
      });
    });

    it('schedule_cancel deletes entry', async () => {
      const out = await handlers.schedule_cancel({ id });
      expect(out.ok).toBe(true);
      expect(out.deletedTitle).toBe('orig');
      expect(repo.findById(id)).toBeNull();
    });

    it('schedule_cancel rejects unknown id', async () => {
      await expect(handlers.schedule_cancel({ id: 99999 })).rejects.toThrow(/not found/i);
    });

    it('schedule_pause sets paused=1', async () => {
      const out = await handlers.schedule_pause({ id });
      expect(out.ok).toBe(true);
      expect(repo.findById(id)?.paused).toBe(1);
    });

    it('schedule_resume on one-shot keeps existing nextFireAt', async () => {
      repo.pause(id);
      const out = await handlers.schedule_resume({ id });
      expect(out.ok).toBe(true);
      const got = repo.findById(id);
      expect(got?.paused).toBe(0);
      expect(got?.nextFireAt).toBe(5_000_000_000_000);
    });

    it('schedule_resume on recurrent recomputes nextFireAt', async () => {
      const recId = repo.insert({
        chatId: 'tg:1',
        title: 'r',
        kind: 'agent',
        payload: 'p',
        recurrence: '0 8 * * *',
        timezone: 'America/Sao_Paulo',
        nextFireAt: 5_000_000_000_000,
        lastFiredAt: null,
        paused: 1,
        createdAt: 1_000_000_000_000,
        createdCorrelationId: 'c',
      });
      const out = await handlers.schedule_resume({ id: recId });
      expect(out.ok).toBe(true);
      const got = repo.findById(recId);
      expect(got?.paused).toBe(0);
      expect(got?.nextFireAt).not.toBe(5_000_000_000_000);
    });

    it('schedule_edit updates title and when', async () => {
      const out = await handlers.schedule_edit({
        id,
        fields: { title: 'novo', when: '2030-06-01T10:00:00Z' },
      });
      expect(out.id).toBe(id);
      const got = repo.findById(id);
      expect(got?.title).toBe('novo');
      expect(got?.nextFireAt).toBe(new Date('2030-06-01T10:00:00Z').getTime());
    });

    it('schedule_edit rejects unknown id', async () => {
      await expect(handlers.schedule_edit({ id: 99999, fields: { title: 'x' } })).rejects.toThrow(
        /not found/i,
      );
    });

    it('schedule_edit rejects empty fields', async () => {
      await expect(handlers.schedule_edit({ id, fields: {} })).rejects.toThrow(/no fields|empty/i);
    });
  });
});
