import { createLogger, type Logger } from '@whis/logger';
import type { ScheduledMessageRecord, ScheduledMessageRepo } from '@whis/storage';
import type { AgentCore } from '@/agent/core';
import type { Channel, IncomingMessage, MessageTarget } from '@/channels/types';
import { computeNextFire } from '@/scheduler/cron';

interface DispatcherOptions {
  repo: ScheduledMessageRepo;
  channels: Channel[];
  agentCore: AgentCore;
  ownerChatId: string;
  catchUpWindowMs: number;
  tickMs: number;
  logger?: Logger;
}

const defaultLogger = createLogger({ service: 'worker' });

export class ScheduledDispatcher {
  private timer: NodeJS.Timeout | null = null;
  private currentTick: Promise<void> | null = null;
  private readonly logger: Logger;

  constructor(private readonly opts: DispatcherOptions) {
    this.logger = opts.logger ?? defaultLogger;
  }

  async start(): Promise<void> {
    const now = Date.now();
    let recurrentSkipped = 0;
    let oneshotCaughtUp = 0;
    let oneshotDropped = 0;

    const allDue = this.opts.repo.findDue(now);
    for (const entry of allDue) {
      if (entry.recurrence !== null) {
        try {
          const next = computeNextFire(entry.recurrence, entry.timezone, now);
          this.opts.repo.markFired(entry.id, entry.lastFiredAt ?? now, next);
          this.logger.info(
            {
              event: 'scheduled_recurrent_skipped',
              id: entry.id,
              was_due_at: entry.nextFireAt,
              next_fire_at: next,
            },
            'recurrent rescheduled past-due',
          );
          recurrentSkipped++;
        } catch (err) {
          this.logger.error(
            { event: 'scheduled_dispatch_failed', id: entry.id, err: String(err) },
            'failed to recompute recurrent on boot',
          );
        }
      } else {
        const ageMs = now - entry.nextFireAt;
        if (ageMs < this.opts.catchUpWindowMs) {
          try {
            await this.dispatch(entry, true);
            this.opts.repo.delete(entry.id);
            oneshotCaughtUp++;
          } catch (err) {
            this.logger.error(
              { event: 'scheduled_dispatch_failed', id: entry.id, err: String(err) },
              'catch-up dispatch failed',
            );
          }
        } else {
          this.opts.repo.delete(entry.id);
          this.logger.warn(
            {
              event: 'scheduled_dropped_stale',
              id: entry.id,
              was_due_at: entry.nextFireAt,
              age_hours: ageMs / 3_600_000,
            },
            'one-shot dropped (>24h stale)',
          );
          oneshotDropped++;
        }
      }
    }

    this.logger.info(
      {
        event: 'scheduler_boot_recovered',
        recurrent_skipped: recurrentSkipped,
        oneshot_caught_up: oneshotCaughtUp,
        oneshot_dropped: oneshotDropped,
      },
      'scheduler boot recovery complete',
    );

    this.timer = setInterval(() => this.scheduleTick(), this.opts.tickMs);
    this.logger.info(
      { event: 'scheduler_started', tick_ms: this.opts.tickMs },
      'scheduler loop started',
    );
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.currentTick) {
      try {
        await this.currentTick;
      } catch {
        // already logged
      }
    }
    this.logger.info({ event: 'scheduler_stopped' }, 'scheduler stopped');
  }

  private scheduleTick(): void {
    if (this.currentTick) return;
    this.currentTick = this.tick().finally(() => {
      this.currentTick = null;
    });
  }

  private async tick(): Promise<void> {
    const start = Date.now();
    const due = this.opts.repo.findDue(start);
    for (const entry of due) {
      try {
        await this.dispatch(entry, false);
        if (entry.recurrence === null) {
          this.opts.repo.delete(entry.id);
        } else {
          const next = computeNextFire(entry.recurrence, entry.timezone, start);
          this.opts.repo.markFired(entry.id, start, next);
        }
      } catch (err) {
        this.logger.error(
          { event: 'scheduled_dispatch_failed', id: entry.id, err: String(err) },
          'tick dispatch failed',
        );
        if (entry.recurrence === null) {
          this.opts.repo.delete(entry.id);
        }
      }
    }
    this.logger.debug(
      { event: 'scheduler_tick', due_count: due.length, took_ms: Date.now() - start },
      'tick completed',
    );
  }

  private async dispatch(entry: ScheduledMessageRecord, isCatchUp: boolean): Promise<void> {
    const target = this.targetFor(entry.chatId);
    const channel = this.channelFor(target.platform);
    if (!channel) {
      throw new Error(`no channel registered for platform=${target.platform}`);
    }

    if (entry.kind === 'literal') {
      const text = isCatchUp ? this.prefixCatchUp(entry.payload, entry.nextFireAt) : entry.payload;
      await channel.send(target, text);
      this.logger.info(
        { event: 'scheduled_dispatched_literal', id: entry.id, title: entry.title },
        'literal dispatched',
      );
      return;
    }

    const payload = isCatchUp
      ? `[scheduled_catchup era=${this.formatHHMM(entry.nextFireAt)}]\n${entry.payload}`
      : entry.payload;
    const synthetic: IncomingMessage & { channel: Channel } = {
      platform: target.platform,
      userId: 'system:scheduler',
      conversationId: entry.chatId,
      threadId: null,
      text: payload,
      correlationId: `scheduled-${entry.id}-${Date.now()}`,
      messageRef: '',
      raw: { scheduled: true },
      scheduledTrigger: { id: entry.id, title: entry.title },
      channel,
    };
    await this.opts.agentCore.dispatchSynthetic(synthetic);
    this.logger.info(
      {
        event: 'scheduled_dispatched_agent',
        id: entry.id,
        title: entry.title,
        correlationId: synthetic.correlationId,
      },
      'agent dispatched',
    );
  }

  private targetFor(chatId: string): MessageTarget {
    const platform = chatId.startsWith('tg:')
      ? 'telegram'
      : chatId.startsWith('wa:')
        ? 'whatsapp'
        : 'telegram';
    return { platform, conversationId: chatId, threadId: null, messageRef: undefined };
  }

  private channelFor(platform: string): Channel | undefined {
    return this.opts.channels.find((c) => c.name === platform);
  }

  private prefixCatchUp(payload: string, wasDueAt: number): string {
    return `(atrasado, era ${this.formatHHMM(wasDueAt)}) ${payload}`;
  }

  private formatHHMM(ts: number): string {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  }
}
