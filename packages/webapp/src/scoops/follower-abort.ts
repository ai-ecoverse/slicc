import { stopOrder } from '../work-unit/policy.js';

export const ABORT_CONFIRM_BOUND_MS = 8_000;
export const ABORT_CONFIRM_POLL_MS = 50;

export interface AbortTarget {
  jid: string;
  parentJid: string | null;
}

export interface FollowerAbortOutcome {
  confirmed: boolean;
  scoopJid: string;

  stopped: string[];
}

export interface ConfirmFollowerStopOptions {
  target: string;
  units(): Iterable<AbortTarget>;
  stop(jid: string): Promise<void> | void;
  isProcessing(jid: string): boolean;
  now(): number;
  sleep(ms: number): Promise<void>;

  boundMs: number;
  pollMs: number;
}

export async function confirmFollowerStop(
  opts: ConfirmFollowerStopOptions
): Promise<FollowerAbortOutcome> {
  const signaled = new Set<string>();
  const deadline = opts.now() + opts.boundMs;
  let idle = false;
  while (opts.now() <= deadline) {
    const ids = stopOrder(opts.units(), opts.target);

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
