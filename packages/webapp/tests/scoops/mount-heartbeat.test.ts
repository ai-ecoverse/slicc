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
});
