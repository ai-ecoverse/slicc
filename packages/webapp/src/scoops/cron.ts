import { Cron } from 'croner';

export function getNextCronTime(expr: string, from: Date): Date | null {
  try {
    return new Cron(expr.trim(), { domAndDow: true }).nextRun(from) ?? null;
  } catch {
    return null;
  }
}
