import { CronExpressionParser } from 'cron-parser';

export function validateCron(expr: string): boolean {
  if (!expr || typeof expr !== 'string') return false;
  try {
    CronExpressionParser.parse(expr);
    return true;
  } catch {
    return false;
  }
}

export function computeNextFire(expr: string, timezone: string, from: number): number {
  const cron = CronExpressionParser.parse(expr, {
    tz: timezone,
    currentDate: new Date(from),
  });
  return cron.next().getTime();
}
