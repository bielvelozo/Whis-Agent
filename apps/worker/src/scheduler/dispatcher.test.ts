import { openDatabase, runMigrations, ScheduledMessageRepo } from '@whis/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel } from '@/channels/types';
import { ScheduledDispatcher } from '@/scheduler/dispatcher';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function makeDeps() {
  const db = openDatabase(':memory:');
  runMigrations(db);
  const repo = new ScheduledMessageRepo(db);

  const sends: { text: string }[] = [];
  const channel = {
    name: 'telegram',
    send: vi.fn(async (_t: unknown, text: string) => {
      sends.push({ text });
      return { messageRef: 'm1' };
    }),
    react: async () => {},
    unreact: async () => {},
    start: async () => {},
    stop: async () => {},
    waitForReaction: async () => null,
    openDm: async () => '',
  } as unknown as Channel;

  const synthetics: unknown[] = [];
  const agentCore = {
    dispatchSynthetic: vi.fn(async (msg: unknown) => {
      synthetics.push(msg);
    }),
  };

  return { db, repo, channel, agentCore, sends, synthetics };
}

describe('ScheduledDispatcher', () => {
  let baseTime: number;

  beforeEach(() => {
    baseTime = new Date('2026-04-26T12:00:00-03:00').getTime();
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('start() catches up one-shot inside 24h window with prefix', async () => {
    const { repo, channel, agentCore, sends } = makeDeps();
    repo.insert({
      chatId: 'tg:1',
      title: 'pão',
      kind: 'literal',
      payload: 'comprar pão',
      recurrence: null,
      timezone: 'America/Sao_Paulo',
      nextFireAt: baseTime - 2 * HOUR,
      lastFiredAt: null,
      paused: 0,
      createdAt: baseTime - 5 * HOUR,
      createdCorrelationId: 'cid-1',
    });
    const dispatcher = new ScheduledDispatcher({
      repo,
      channels: [channel],
      // biome-ignore lint/suspicious/noExplicitAny: minimal mock
      agentCore: agentCore as any,
      ownerChatId: 'tg:1',
      catchUpWindowMs: DAY,
      tickMs: 60_000,
    });
    await dispatcher.start();
    expect(sends).toHaveLength(1);
    expect(sends[0].text).toMatch(/^\(atrasado/);
    expect(sends[0].text).toContain('comprar pão');
    expect(repo.findDue(baseTime)).toHaveLength(0);
    await dispatcher.stop();
  });

  it('catch-up prefix renders HH:MM in entry timezone, not server TZ', async () => {
    // baseTime is 2026-04-26T12:00:00-03:00 == 15:00 UTC.
    // nextFireAt = baseTime - 2h = 13:00 UTC.
    //   In America/Sao_Paulo (UTC-3, no DST): 10:00.
    //   In Asia/Tokyo (UTC+9, no DST):        22:00.
    // The container runs in UTC, so a naive Date#getHours() would print "13"
    // instead of either user-meaningful value.
    const { repo, channel, agentCore, sends, synthetics } = makeDeps();
    repo.insert({
      chatId: 'tg:1',
      title: 'literal-sp',
      kind: 'literal',
      payload: 'remind-sp',
      recurrence: null,
      timezone: 'America/Sao_Paulo',
      nextFireAt: baseTime - 2 * HOUR,
      lastFiredAt: null,
      paused: 0,
      createdAt: baseTime - 5 * HOUR,
      createdCorrelationId: 'cid-tz-lit-sp',
    });
    repo.insert({
      chatId: 'tg:1',
      title: 'literal-tokyo',
      kind: 'literal',
      payload: 'remind-tokyo',
      recurrence: null,
      timezone: 'Asia/Tokyo',
      nextFireAt: baseTime - 2 * HOUR,
      lastFiredAt: null,
      paused: 0,
      createdAt: baseTime - 5 * HOUR,
      createdCorrelationId: 'cid-tz-lit-tokyo',
    });
    repo.insert({
      chatId: 'tg:1',
      title: 'agent-sp',
      kind: 'agent',
      payload: 'do thing',
      recurrence: null,
      timezone: 'America/Sao_Paulo',
      nextFireAt: baseTime - 2 * HOUR,
      lastFiredAt: null,
      paused: 0,
      createdAt: baseTime - 5 * HOUR,
      createdCorrelationId: 'cid-tz-agent-sp',
    });
    const dispatcher = new ScheduledDispatcher({
      repo,
      channels: [channel],
      // biome-ignore lint/suspicious/noExplicitAny: minimal mock
      agentCore: agentCore as any,
      ownerChatId: 'tg:1',
      catchUpWindowMs: DAY,
      tickMs: 60_000,
    });
    await dispatcher.start();
    expect(sends.find((s) => s.text.includes('remind-sp'))?.text).toBe(
      '(atrasado, era 10:00) remind-sp',
    );
    expect(sends.find((s) => s.text.includes('remind-tokyo'))?.text).toBe(
      '(atrasado, era 22:00) remind-tokyo',
    );
    const agentMsg = synthetics[0] as { text: string };
    expect(agentMsg.text).toContain('[scheduled_catchup era=10:00]');
    await dispatcher.stop();
  });

  it('start() drops one-shot older than 24h silently', async () => {
    const { repo, channel, agentCore, sends } = makeDeps();
    repo.insert({
      chatId: 'tg:1',
      title: 'velho',
      kind: 'literal',
      payload: 'esquecer',
      recurrence: null,
      timezone: 'America/Sao_Paulo',
      nextFireAt: baseTime - 25 * HOUR,
      lastFiredAt: null,
      paused: 0,
      createdAt: baseTime - 30 * HOUR,
      createdCorrelationId: 'cid-2',
    });
    const dispatcher = new ScheduledDispatcher({
      repo,
      channels: [channel],
      // biome-ignore lint/suspicious/noExplicitAny: minimal mock
      agentCore: agentCore as any,
      ownerChatId: 'tg:1',
      catchUpWindowMs: DAY,
      tickMs: 60_000,
    });
    await dispatcher.start();
    expect(sends).toHaveLength(0);
    expect(repo.findById(1)).toBeNull();
    await dispatcher.stop();
  });

  it('start() recomputes recurrent past due without firing', async () => {
    const { repo, channel, agentCore, sends } = makeDeps();
    const oldNext = baseTime - 4 * HOUR;
    const id = repo.insert({
      chatId: 'tg:1',
      title: 'bom-dia',
      kind: 'agent',
      payload: 'gera bom dia',
      recurrence: '0 8 * * *',
      timezone: 'America/Sao_Paulo',
      nextFireAt: oldNext,
      lastFiredAt: null,
      paused: 0,
      createdAt: baseTime - 10 * DAY,
      createdCorrelationId: 'cid-3',
    });
    const dispatcher = new ScheduledDispatcher({
      repo,
      channels: [channel],
      // biome-ignore lint/suspicious/noExplicitAny: minimal mock
      agentCore: agentCore as any,
      ownerChatId: 'tg:1',
      catchUpWindowMs: DAY,
      tickMs: 60_000,
    });
    await dispatcher.start();
    expect(sends).toHaveLength(0);
    const updated = repo.findById(id);
    expect(updated?.nextFireAt).toBeGreaterThan(baseTime);
    await dispatcher.stop();
  });

  it('tick dispatches literal entry due', async () => {
    const { repo, channel, agentCore, sends } = makeDeps();
    repo.insert({
      chatId: 'tg:1',
      title: 't',
      kind: 'literal',
      payload: 'now',
      recurrence: null,
      timezone: 'America/Sao_Paulo',
      nextFireAt: baseTime + 30_000,
      lastFiredAt: null,
      paused: 0,
      createdAt: baseTime,
      createdCorrelationId: 'cid-4',
    });
    const dispatcher = new ScheduledDispatcher({
      repo,
      channels: [channel],
      // biome-ignore lint/suspicious/noExplicitAny: minimal mock
      agentCore: agentCore as any,
      ownerChatId: 'tg:1',
      catchUpWindowMs: DAY,
      tickMs: 60_000,
    });
    await dispatcher.start();
    sends.length = 0;
    vi.advanceTimersByTime(60_000);
    await vi.runOnlyPendingTimersAsync();
    expect(sends).toHaveLength(1);
    expect(sends[0].text).toBe('now');
    await dispatcher.stop();
  });

  it('tick dispatches agent entry via dispatchSynthetic', async () => {
    const { repo, channel, agentCore, synthetics } = makeDeps();
    repo.insert({
      chatId: 'tg:1',
      title: 'bom-dia',
      kind: 'agent',
      payload: 'manda bom dia',
      recurrence: null,
      timezone: 'America/Sao_Paulo',
      nextFireAt: baseTime + 30_000,
      lastFiredAt: null,
      paused: 0,
      createdAt: baseTime,
      createdCorrelationId: 'cid-5',
    });
    const dispatcher = new ScheduledDispatcher({
      repo,
      channels: [channel],
      // biome-ignore lint/suspicious/noExplicitAny: minimal mock
      agentCore: agentCore as any,
      ownerChatId: 'tg:1',
      catchUpWindowMs: DAY,
      tickMs: 60_000,
    });
    await dispatcher.start();
    synthetics.length = 0;
    vi.advanceTimersByTime(60_000);
    await vi.runOnlyPendingTimersAsync();
    expect(synthetics).toHaveLength(1);
    expect(agentCore.dispatchSynthetic).toHaveBeenCalledTimes(1);
    await dispatcher.stop();
  });

  it('tick: failure of one entry does not derail others', async () => {
    const { repo, channel, agentCore, sends } = makeDeps();
    (channel.send as unknown as ReturnType<typeof vi.fn>) = vi.fn(
      async (_t: unknown, text: string) => {
        if (text === 'fail') throw new Error('boom');
        sends.push({ text });
        return { messageRef: 'm' };
      },
    );
    repo.insert({
      chatId: 'tg:1',
      title: 'a',
      kind: 'literal',
      payload: 'fail',
      recurrence: null,
      timezone: 'America/Sao_Paulo',
      nextFireAt: baseTime + 30_000,
      lastFiredAt: null,
      paused: 0,
      createdAt: baseTime,
      createdCorrelationId: 'cid-a',
    });
    repo.insert({
      chatId: 'tg:1',
      title: 'b',
      kind: 'literal',
      payload: 'ok',
      recurrence: null,
      timezone: 'America/Sao_Paulo',
      nextFireAt: baseTime + 30_000,
      lastFiredAt: null,
      paused: 0,
      createdAt: baseTime,
      createdCorrelationId: 'cid-b',
    });
    const dispatcher = new ScheduledDispatcher({
      repo,
      channels: [channel],
      // biome-ignore lint/suspicious/noExplicitAny: minimal mock
      agentCore: agentCore as any,
      ownerChatId: 'tg:1',
      catchUpWindowMs: DAY,
      tickMs: 60_000,
    });
    await dispatcher.start();
    sends.length = 0;
    vi.advanceTimersByTime(60_000);
    await vi.runOnlyPendingTimersAsync();
    expect(sends).toEqual([{ text: 'ok' }]);
    await dispatcher.stop();
  });

  it('recurrent fired entry advances next_fire_at instead of deletion', async () => {
    const { repo, channel, agentCore } = makeDeps();
    const id = repo.insert({
      chatId: 'tg:1',
      title: 'r',
      kind: 'literal',
      payload: 'recurrent',
      recurrence: '0 8 * * *',
      timezone: 'America/Sao_Paulo',
      nextFireAt: baseTime + 30_000,
      lastFiredAt: null,
      paused: 0,
      createdAt: baseTime,
      createdCorrelationId: 'cid-r',
    });
    const dispatcher = new ScheduledDispatcher({
      repo,
      channels: [channel],
      // biome-ignore lint/suspicious/noExplicitAny: minimal mock
      agentCore: agentCore as any,
      ownerChatId: 'tg:1',
      catchUpWindowMs: DAY,
      tickMs: 60_000,
    });
    await dispatcher.start();
    vi.advanceTimersByTime(60_000);
    await vi.runOnlyPendingTimersAsync();
    const got = repo.findById(id);
    expect(got).not.toBeNull();
    expect(got?.nextFireAt).toBeGreaterThan(baseTime + 60_000);
    expect(got?.lastFiredAt).toBeGreaterThan(0);
    await dispatcher.stop();
  });

  it('paused entry does not fire', async () => {
    const { repo, channel, agentCore, sends } = makeDeps();
    repo.insert({
      chatId: 'tg:1',
      title: 'p',
      kind: 'literal',
      payload: 'no fire',
      recurrence: null,
      timezone: 'America/Sao_Paulo',
      nextFireAt: baseTime + 30_000,
      lastFiredAt: null,
      paused: 1,
      createdAt: baseTime,
      createdCorrelationId: 'cid-p',
    });
    const dispatcher = new ScheduledDispatcher({
      repo,
      channels: [channel],
      // biome-ignore lint/suspicious/noExplicitAny: minimal mock
      agentCore: agentCore as any,
      ownerChatId: 'tg:1',
      catchUpWindowMs: DAY,
      tickMs: 60_000,
    });
    await dispatcher.start();
    vi.advanceTimersByTime(60_000);
    await vi.runOnlyPendingTimersAsync();
    expect(sends).toHaveLength(0);
    await dispatcher.stop();
  });

  it('stop() clears interval — no further dispatches', async () => {
    const { repo, channel, agentCore, sends } = makeDeps();
    const dispatcher = new ScheduledDispatcher({
      repo,
      channels: [channel],
      // biome-ignore lint/suspicious/noExplicitAny: minimal mock
      agentCore: agentCore as any,
      ownerChatId: 'tg:1',
      catchUpWindowMs: DAY,
      tickMs: 60_000,
    });
    await dispatcher.start();
    await dispatcher.stop();
    repo.insert({
      chatId: 'tg:1',
      title: 'after',
      kind: 'literal',
      payload: 'should not send',
      recurrence: null,
      timezone: 'America/Sao_Paulo',
      nextFireAt: baseTime + 30_000,
      lastFiredAt: null,
      paused: 0,
      createdAt: baseTime,
      createdCorrelationId: 'cid-after',
    });
    vi.advanceTimersByTime(60_000);
    await vi.runOnlyPendingTimersAsync();
    expect(sends).toHaveLength(0);
  });
});
