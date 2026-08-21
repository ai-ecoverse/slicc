import { describe, expect, it } from 'vitest';
import {
  makeSleepWithProgress,
  ProgressEmitter,
  type ProgressEvent,
  SLEEP_TICK_MS,
} from '../../../src/shell/progress/index.js';

/** Deterministic clock + timer: each `setTimeout` advances the clock by its delay. */
function mockClock() {
  let now = 1_000;
  const delays: number[] = [];
  const setTimeout = (fn: () => void, ms: number) => {
    delays.push(ms);
    now += ms;
    queueMicrotask(fn);
    return 0;
  };
  return { now: () => now, setTimeout, delays, advance: (ms: number) => (now += ms) };
}

function collect() {
  const seen: ProgressEvent[] = [];
  // `now` is shared with the clock by the caller; throttle is disabled via a
  // monotonically jumping clock (every tick is ≥250 ms apart).
  return { seen, sink: (e: ProgressEvent) => seen.push(e) };
}

describe('makeSleepWithProgress', () => {
  it('emits start, 250 ms ticks with fraction = elapsed/total, then end', async () => {
    const clock = mockClock();
    const { seen, sink } = collect();
    const emitter = new ProgressEmitter({ sink, now: clock.now });
    const sleep = makeSleepWithProgress(emitter, { now: clock.now, setTimeout: clock.setTimeout });

    await sleep(1000);

    expect(clock.delays).toEqual([250, 250, 250, 250]);
    expect(seen[0]).toMatchObject({
      phase: 'start',
      fraction: 0,
      etaMs: 1000,
      total: 1000,
      unit: 'ms',
    });
    expect(seen[0].label).toBe('sleep 1');
    const updates = seen.filter((e) => e.phase === 'update');
    expect(updates.map((e) => e.fraction)).toEqual([0.25, 0.5, 0.75]);
    expect(updates.map((e) => e.etaMs)).toEqual([750, 500, 250]);
    expect(seen.at(-1)).toMatchObject({ phase: 'end', fraction: 1, etaMs: 0, done: 1000 });
    expect(new Set(seen.map((e) => e.id)).size).toBe(1);
  });

  it('uses a shorter final slice so it never oversleeps', async () => {
    const clock = mockClock();
    const emitter = new ProgressEmitter({ sink: () => {}, now: clock.now });
    const sleep = makeSleepWithProgress(emitter, { now: clock.now, setTimeout: clock.setTimeout });
    const before = clock.now();
    await sleep(600);
    expect(clock.delays).toEqual([250, 250, 100]);
    expect(clock.now() - before).toBe(600);
  });

  it('labels fractional seconds', async () => {
    const clock = mockClock();
    const { seen, sink } = collect();
    const emitter = new ProgressEmitter({ sink, now: clock.now });
    const sleep = makeSleepWithProgress(emitter, { now: clock.now, setTimeout: clock.setTimeout });
    await sleep(SLEEP_TICK_MS * 2 + 50);
    expect(seen[0].label).toBe('sleep 0.6');
  });

  it('stops ticking and closes the unit when the run is aborted', async () => {
    const clock = mockClock();
    const { seen, sink } = collect();
    const emitter = new ProgressEmitter({ sink, now: clock.now });
    let aborted = false;
    const sleep = makeSleepWithProgress(emitter, {
      now: clock.now,
      setTimeout: (fn, ms) => {
        // Abort mid-way through the second slice.
        if (clock.delays.length === 1) aborted = true;
        return clock.setTimeout(fn, ms);
      },
      isAborted: () => aborted,
    });
    await sleep(10_000);
    expect(clock.delays.length).toBe(2);
    expect(seen.at(-1)?.phase).toBe('end');
    expect(seen.filter((e) => e.phase === 'update').length).toBeLessThanOrEqual(2);
  });

  it('handles zero and negative durations without ticking', async () => {
    const clock = mockClock();
    const { seen, sink } = collect();
    const emitter = new ProgressEmitter({ sink, now: clock.now });
    const sleep = makeSleepWithProgress(emitter, { now: clock.now, setTimeout: clock.setTimeout });
    await sleep(0);
    await sleep(-5);
    expect(clock.delays).toEqual([]);
    expect(seen.map((e) => e.phase)).toEqual(['start', 'end', 'start', 'end']);
  });

  it('is silent (but still sleeps) without a sink', async () => {
    const clock = mockClock();
    const emitter = new ProgressEmitter({ now: clock.now });
    const sleep = makeSleepWithProgress(emitter, { now: clock.now, setTimeout: clock.setTimeout });
    await sleep(500);
    expect(clock.delays).toEqual([250, 250]);
  });
});
