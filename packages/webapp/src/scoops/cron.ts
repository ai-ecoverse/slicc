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
 */
export function getNextCronTime(expr: string, from: Date): Date | null {
  try {
    return new Cron(expr.trim()).nextRun(from) ?? null;
  } catch {
    return null;
  }
}
