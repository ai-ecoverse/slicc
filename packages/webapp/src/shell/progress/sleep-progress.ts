/**
 * `BashOptions.sleep` implementation that reports progress.
 *
 * just-bash's `sleep` command calls `ctx.sleep(ms)` when the option is set
 * and races it against the command's abort signal (returning early on abort
 * but NOT cancelling the promise). We therefore tick in 250 ms slices and ask
 * an optional `isAborted()` probe between slices so a cancelled `sleep 300`
 * stops emitting within one slice.
 *
 * Defense-in-depth: just-bash may patch `setTimeout` while a script runs, so
 * the ticker uses a reference captured at module load — exactly what
 * just-bash's own default sleep does — rather than whatever the global
 * points at mid-exec. Tests inject their own timer.
 */

import type { ProgressEmitter } from './emitter.js';

/** Tick interval — also the UI's maximum refresh rate for a single sleep. */
export const SLEEP_TICK_MS = 250;

const capturedSetTimeout: typeof globalThis.setTimeout = globalThis.setTimeout.bind(globalThis);

export interface SleepWithProgressOptions {
  now?: () => number;
  /** Timer primitive; defaults to `setTimeout` captured at module load. */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  /** Probe for the current run's cancellation; checked between ticks. */
  isAborted?: () => boolean;
  /** Label prefix; the total seconds are appended ("sleep 30"). */
  label?: (totalMs: number) => string;
}

function defaultLabel(totalMs: number): string {
  const secs = totalMs / 1000;
  return `sleep ${Number.isInteger(secs) ? secs : secs.toFixed(1)}`;
}

/** Build the `BashOptions.sleep` function. */
export function makeSleepWithProgress(
  emitter: ProgressEmitter,
  options: SleepWithProgressOptions = {}
): (ms: number) => Promise<void> {
  const now = options.now ?? Date.now;
  const timer = options.setTimeout ?? capturedSetTimeout;
  const isAborted = options.isAborted ?? (() => false);
  const labelFor = options.label ?? defaultLabel;
  const wait = (ms: number) => new Promise<void>((resolve) => timer(resolve, ms));

  return async (ms: number): Promise<void> => {
    const total = Math.max(0, ms);
    const id = emitter.allocateId('sleep');
    const label = labelFor(total);
    const startedAt = now();
    emitter.emit({
      id,
      label,
      fraction: 0,
      etaMs: total,
      done: 0,
      total,
      unit: 'ms',
      phase: 'start',
    });
    try {
      let elapsed = 0;
      while (elapsed < total) {
        if (isAborted()) return;
        await wait(Math.min(SLEEP_TICK_MS, total - elapsed));
        elapsed = now() - startedAt;
        if (elapsed < total) {
          const fraction = Math.min(1, elapsed / total);
          emitter.emit({
            id,
            label,
            fraction,
            etaMs: Math.max(0, total - elapsed),
            done: Math.min(elapsed, total),
            total,
            unit: 'ms',
            phase: 'update',
          });
        }
      }
    } finally {
      emitter.emit({
        id,
        label,
        fraction: 1,
        etaMs: 0,
        done: total,
        total,
        unit: 'ms',
        phase: 'end',
      });
    }
  };
}
