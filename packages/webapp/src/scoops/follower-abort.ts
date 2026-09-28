/**
 * Confirm a follower's `abort`: stop the unit it named and every scoop that
 * unit owns, then say so only once none of them are still processing.
 */

import { stopOrder } from '../work-unit/policy.js';

/** Stay under the CLI's confirm bound (12s) so a failed stop is the CLI's timeout, not a late ack. */
export const ABORT_CONFIRM_BOUND_MS = 8_000;
export const ABORT_CONFIRM_POLL_MS = 50;

export interface AbortTarget {
  jid: string;
  parentJid: string | null;
}

/** What the leader tells the follower that sent `abort`. */
export interface FollowerAbortOutcome {
  confirmed: boolean;
  scoopJid: string;
  /** Deepest first, the named unit last. Present whether or not the stop held. */
  stopped: string[];
}

export interface ConfirmFollowerStopOptions {
  target: string;
  units(): Iterable<AbortTarget>;
  stop(jid: string): Promise<void> | void;
  isProcessing(jid: string): boolean;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** How long to wait for the stopped units to leave `processing`. */
  boundMs: number;
  pollMs: number;
}

/**
 * Stop `target`'s tree and wait until two successive looks see none of it
 * processing. The second look is what catches a scoop that appeared, or
 * flipped back to processing, between the stop and the ack.
 */
export async function confirmFollowerStop(
  opts: ConfirmFollowerStopOptions
): Promise<FollowerAbortOutcome> {
  const signaled = new Set<string>();
  const deadline = opts.now() + opts.boundMs;
  let idle = false;
  while (opts.now() <= deadline) {
    const ids = stopOrder(opts.units(), opts.target);
    // A tool already in flight can register a child after the first stop.
    // Re-sample ownership until the ack, and stop every newly arrived child.
    const added = ids.filter((id) => !signaled.has(id));
    try {
      for (const id of added) {
        await opts.stop(id);
        signaled.add(id);
      }
    } catch {
      return { confirmed: false, scoopJid: opts.target, stopped: ids };
    }
    const busy = ids.some((id) => opts.isProcessing(id));
    if (!busy && idle && added.length === 0) {
      return { confirmed: true, scoopJid: opts.target, stopped: ids };
    }
    idle = !busy && added.length === 0;
    await opts.sleep(opts.pollMs);
  }
  return { confirmed: false, scoopJid: opts.target, stopped: stopOrder(opts.units(), opts.target) };
}
