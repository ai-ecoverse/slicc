/**
 * Cron scheduling helper shared by LickManager and TaskScheduler.
 *
 * Wraps `croner`, which computes the next firing in closed form and validates
 * field bounds, replacing the bespoke minute-by-minute search both schedulers
 * used to carry.
 */

import { Cron } from 'croner';

/**
 * Return the next time `expr` fires strictly after `from`, or `null` when the
 * expression is invalid or never fires again.
 *
 * `domAndDow: true` keeps the legacy AND semantics for schedules that
 * constrain both day-of-month and day-of-week (e.g. `0 9 1 * 1` fires only
 * when the 1st is a Monday), matching the bespoke parser this replaced rather
 * than croner's default POSIX OR semantics.
 */
export function getNextCronTime(expr: string, from: Date): Date | null {
  try {
    return new Cron(expr.trim(), { domAndDow: true }).nextRun(from) ?? null;
  } catch {
    return null;
  }
}
