/**
 * `timeout DURATION cmd …` progress: the limit is known up front, so while the
 * inner command runs we tick `fraction = elapsed / limit` every 250 ms and
 * close the unit as soon as `execute` settles (early finish or the limit).
 *
 * Same timer discipline as `sleep-progress.ts`: a `setTimeout` reference
 * captured at module load, never the mid-exec global.
 */

import type { Command, ResolvedCommandContext } from 'just-bash';
import { type ProgressEmitter, progressLabel } from './emitter.js';
import { SLEEP_TICK_MS } from './sleep-progress.js';

type CommandExecResult = Awaited<ReturnType<Command['execute']>>;

const capturedSetTimeout: typeof globalThis.setTimeout = globalThis.setTimeout.bind(globalThis);

export interface TimeoutProgressOptions {
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
}

/** Parse coreutils-style `NUMBER[smhd]` into ms; null when invalid. */
export function parseDurationMs(raw: string): number | null {
  const m = /^(\d+(?:\.\d+)?|\.\d+)([smhd]?)$/.exec(raw.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = { '': 1000, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]] ?? 1000;
  return n * unit;
}

/** Index of the DURATION operand in `timeout` argv (skips options), or -1. */
export function timeoutDurationIndex(args: readonly string[]): number {
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === '--') return i + 1 < args.length ? i + 1 : -1;
    if (!a.startsWith('-')) return i;
    if (['-k', '--kill-after', '-s', '--signal'].includes(a)) i += 1;
    i += 1;
  }
  return -1;
}

/** Decorate just-bash's `timeout` with a determinate ticker. */
export function wrapTimeoutForProgress(
  command: Command,
  emitter: ProgressEmitter,
  options: TimeoutProgressOptions = {}
): Command {
  const now = options.now ?? Date.now;
  const timer = options.setTimeout ?? capturedSetTimeout;
  return {
    ...command,
    async execute(args: string[], ctx: ResolvedCommandContext): Promise<CommandExecResult> {
      const idx = timeoutDurationIndex(args);
      const limit = idx >= 0 ? parseDurationMs(args[idx]) : null;
      if (!emitter.hasSink() || limit === null || limit <= 0) return command.execute(args, ctx);

      const id = emitter.allocateId('timeout');
      const label = progressLabel(command.name, args);
      const startedAt = now();
      let running = true;
      const tick = (): void => {
        if (!running) return;
        const elapsed = now() - startedAt;
        const fraction = Math.min(1, elapsed / limit);
        emitter.emit({
          id,
          label,
          fraction,
          etaMs: Math.max(0, limit - elapsed),
          done: Math.min(elapsed, limit),
          total: limit,
          unit: 'ms',
          phase: 'update',
        });
        if (elapsed < limit) timer(tick, SLEEP_TICK_MS);
      };
      emitter.emit({
        id,
        label,
        fraction: 0,
        etaMs: limit,
        done: 0,
        total: limit,
        unit: 'ms',
        phase: 'start',
      });
      timer(tick, SLEEP_TICK_MS);
      try {
        return await command.execute(args, ctx);
      } finally {
        running = false;
        emitter.emit({
          id,
          label,
          fraction: 1,
          etaMs: 0,
          done: limit,
          total: limit,
          unit: 'ms',
          phase: 'end',
        });
      }
    },
  };
}
