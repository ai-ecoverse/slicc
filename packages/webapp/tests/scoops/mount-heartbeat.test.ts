import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MOUNT_HEARTBEAT_INTERVAL_MS,
  MOUNT_HEARTBEAT_MAX_BEATS,
  withMountHeartbeat,
} from '../../src/scoops/mount-heartbeat.js';

// The shared-FS mount heartbeat (2026-08-18 cold-boot brick): the OPFS
// mount + pre-boot sidecar repair is O(tree size) and silent, so a cold
// boot of a large tree blew the page's 30s kernel-ready watchdog (#2007).
// The helper beats the watchdog while the mount is in flight — capped, so
// a genuinely wedged mount still times out.
describe('withMountHeartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes the result through and emits start + interval beats', async () => {
    const stages: string[] = [];
    let resolveWork: (v: string) => void = () => {};
    const work = new Promise<string>((r) => {
      resolveWork = r;
    });
    const p = withMountHeartbeat(
      () => work,
      (s) => stages.push(s)
    );
    expect(stages).toEqual(['shared-fs-mount:start']);
    await vi.advanceTimersByTimeAsync(MOUNT_HEARTBEAT_INTERVAL_MS * 3);
    expect(stages).toEqual([
      'shared-fs-mount:start',
      'shared-fs-mount:1',
      'shared-fs-mount:2',
      'shared-fs-mount:3',
    ]);
    resolveWork('mounted');
    await expect(p).resolves.toBe('mounted');
    // Beats stop once the mount resolves.
    await vi.advanceTimersByTimeAsync(MOUNT_HEARTBEAT_INTERVAL_MS * 2);
    expect(stages).toHaveLength(4);
  });

  it('caps the beats so a wedged mount stops re-arming the watchdog', async () => {
    const stages: string[] = [];
    const never = new Promise<never>(() => {});
    void withMountHeartbeat(
      () => never,
      (s) => stages.push(s)
    );
    await vi.advanceTimersByTimeAsync(
      MOUNT_HEARTBEAT_INTERVAL_MS * (MOUNT_HEARTBEAT_MAX_BEATS + 10)
    );
    // start + capped interval beats, nothing past the cap — the watchdog
    // must regain authority over a mount that never finishes.
    expect(stages).toHaveLength(1 + MOUNT_HEARTBEAT_MAX_BEATS);
    expect(vi.getTimerCount()).toBe(0); // capped timer cleared itself
  });

  it('clears the timer and rethrows when the mount fails', async () => {
    const stages: string[] = [];
    const boom = new Error('mount failed');
    const p = withMountHeartbeat(
      () => Promise.reject(boom),
      (s) => stages.push(s)
    );
    await expect(p).rejects.toBe(boom);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(MOUNT_HEARTBEAT_INTERVAL_MS * 2);
    expect(stages).toEqual(['shared-fs-mount:start']);
  });

  it('is a plain passthrough with no callback', async () => {
    await expect(withMountHeartbeat(async () => 42)).resolves.toBe(42);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('hands the work a callable no-op tick even with no callback', async () => {
    // The orchestrator always threads the tick into VirtualFS.create; it
    // must be safe to call when there is no onProgress consumer.
    await expect(
      withMountHeartbeat(async (tick) => {
        tick();
        tick();
        return 'ok';
      })
    ).resolves.toBe('ok');
  });

  // 2026-08-24 field wedge: the same repair took ~8 minutes on an
  // I/O-starved disk — far past the old TIME cap — while provably
  // advancing entry by entry. Ticks must keep the beats flowing.
  it('beats past the cap for as long as ticks keep advancing', async () => {
    const stages: string[] = [];
    let tick: () => void = () => {};
    const never = new Promise<never>(() => {});
    void withMountHeartbeat(
      (t) => {
        tick = t;
        return never;
      },
      (s) => stages.push(s)
    );
    const rounds = MOUNT_HEARTBEAT_MAX_BEATS * 3;
    for (let i = 0; i < rounds; i += 1) {
      tick(); // at least one unit of progress per interval
      await vi.advanceTimersByTimeAsync(MOUNT_HEARTBEAT_INTERVAL_MS);
    }
    // start + one beat per advancing interval — no cap applied.
    expect(stages).toHaveLength(1 + rounds);
    expect(stages.at(-1)).toBe(`shared-fs-mount:${rounds}`);
  });

  it('a tick resets the quiet run, then the cap counts silence only', async () => {
    const stages: string[] = [];
    let tick: () => void = () => {};
    const never = new Promise<never>(() => {});
    void withMountHeartbeat(
      (t) => {
        tick = t;
        return never;
      },
      (s) => stages.push(s)
    );
    // Nearly exhaust the quiet budget…
    await vi.advanceTimersByTimeAsync(
      MOUNT_HEARTBEAT_INTERVAL_MS * (MOUNT_HEARTBEAT_MAX_BEATS - 1)
    );
    expect(stages).toHaveLength(1 + (MOUNT_HEARTBEAT_MAX_BEATS - 1));
    // …then one unit of progress restores the full quiet budget: one
    // reset beat + MAX quiet beats before silence…
    tick();
    await vi.advanceTimersByTimeAsync(
      MOUNT_HEARTBEAT_INTERVAL_MS * (MOUNT_HEARTBEAT_MAX_BEATS + 1)
    );
    const expected = 1 + (MOUNT_HEARTBEAT_MAX_BEATS - 1) + (MOUNT_HEARTBEAT_MAX_BEATS + 1);
    expect(stages).toHaveLength(expected);
    // …and once the budget is spent with no further ticks, the beat stays
    // quiet: the watchdog regains authority.
    await vi.advanceTimersByTimeAsync(MOUNT_HEARTBEAT_INTERVAL_MS * 10);
    expect(stages).toHaveLength(expected);
    expect(vi.getTimerCount()).toBe(0);
  });
});
