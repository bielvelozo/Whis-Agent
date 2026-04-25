// packages/logger/src/index.ts
import { pino, type Logger as PinoLogger } from 'pino';

export type Logger = PinoLogger;

export interface CreateLoggerOptions {
  service: string;
  level?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
}

export function createLogger(opts: CreateLoggerOptions): Logger {
  return pino({
    base: { service: opts.service },
    level: opts.level ?? process.env.LOG_LEVEL ?? 'info',
    formatters: {
      level: (label) => ({ level: label }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
