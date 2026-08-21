import type { Command, ResolvedCommandContext } from 'just-bash';
import { describe, expect, it } from 'vitest';
import {
  ProgressEmitter,
  type ProgressEvent,
  parseDurationMs,
  timeoutDurationIndex,
  wrapTimeoutForProgress,
} from '../../../src/shell/progress/index.js';

const ctx = {} as ResolvedCommandContext;

describe('parseDurationMs / timeoutDurationIndex', () => {
  it('parses coreutils durations', () => {
    expect(parseDurationMs('5')).toBe(5000);
    expect(parseDurationMs('2.5s')).toBe(2500);
    expect(parseDurationMs('1m')).toBe(60_000);
    expect(parseDurationMs('1h')).toBe(3_600_000);
    expect(parseDurationMs('abc')).toBeNull();
  });
  it('finds the duration after options', () => {
    expect(timeoutDurationIndex(['5', 'sleep', '9'])).toBe(0);
    expect(timeoutDurationIndex(['-k', '1', '--signal', 'TERM', '5s', 'ls'])).toBe(4);
    expect(timeoutDurationIndex(['--preserve-status', '--', '3', 'ls'])).toBe(2);
    expect(timeoutDurationIndex(['-k'])).toBe(-1);
  });
});

describe('wrapTimeoutForProgress', () => {
  function harness(durationMs: number) {
    let t = 0;
    const seen: ProgressEvent[] = [];
    const emitter = new ProgressEmitter({ sink: (e) => seen.push(e), now: () => t });
    const timers: Array<() => void> = [];
    let resolveInner: (() => void) | null = null;
    const inner: Command = {
      name: 'timeout',
      execute: () =>
        new Promise((resolve) => {
          resolveInner = () => resolve({ stdout: '', stderr: '', exitCode: 0 });
        }),
    };
    const wrapped = wrapTimeoutForProgress(inner, emitter, {
      now: () => t,
      setTimeout: (fn, ms) => {
        timers.push(() => {
          t += ms;
          fn();
        });
        return 0;
      },
    });
    return {
      seen,
      wrapped,
      fireTimer: () => timers.shift()?.(),
      finish: () => resolveInner?.(),
      durationMs,
    };
  }

  it('ticks fraction = elapsed/limit and ends when the command finishes early', async () => {
    const h = harness(1000);
    const done = h.wrapped.execute(['1', 'sleep', '5'], ctx);
    expect(h.seen[0]).toMatchObject({ phase: 'start', fraction: 0, total: 1000, unit: 'ms' });
    h.fireTimer();
    h.fireTimer();
    expect(h.seen.filter((e) => e.phase === 'update').map((e) => e.fraction)).toEqual([0.25, 0.5]);
    h.finish();
    await done;
    expect(h.seen.at(-1)).toMatchObject({ phase: 'end', fraction: 1 });
    // Ticks after completion are ignored.
    const before = h.seen.length;
    h.fireTimer();
    expect(h.seen.length).toBe(before);
  });

  it('passes through untouched without a sink or with an invalid duration', async () => {
    const silent = new ProgressEmitter();
    const wrapped = wrapTimeoutForProgress(
      { name: 'timeout', execute: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }) },
      silent
    );
    expect((await wrapped.execute(['5', 'ls'], ctx)).stdout).toBe('ok');
    const seen: ProgressEvent[] = [];
    const loud = new ProgressEmitter({ sink: (e) => seen.push(e) });
    const wrapped2 = wrapTimeoutForProgress(
      { name: 'timeout', execute: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }) },
      loud
    );
    await wrapped2.execute(['nope', 'ls'], ctx);
    expect(seen).toEqual([]);
  });
});
