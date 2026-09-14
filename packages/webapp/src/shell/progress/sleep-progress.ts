import type { ProgressEmitter } from './emitter.js';

export const SLEEP_TICK_MS = 250;

const capturedSetTimeout: typeof globalThis.setTimeout = globalThis.setTimeout.bind(globalThis);

export interface SleepWithProgressOptions {
  now?: () => number;

  setTimeout?: (fn: () => void, ms: number) => unknown;

  isAborted?: () => boolean;

  label?: (totalMs: number) => string;
}

function defaultLabel(totalMs: number): string {
  const secs = totalMs / 1000;
  return `sleep ${Number.isInteger(secs) ? secs : secs.toFixed(1)}`;
}

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
