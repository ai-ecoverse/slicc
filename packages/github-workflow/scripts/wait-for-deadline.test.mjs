import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setup } from '../tests/helpers.mjs';
import { writeState } from './gh-io.mjs';
import { main, resolveDeadline } from './wait-for-deadline.mjs';

describe('wait-for-deadline', () => {
  let t;
  beforeEach(() => {
    t = setup();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    t.teardown();
    vi.restoreAllMocks();
  });

  it('resolves the deadline from until (ISO or duration) or the state', () => {
    expect(resolveDeadline({}, '2026-09-15T10:00:00Z')).toBe(Date.parse('2026-09-15T10:00:00Z'));
    expect(resolveDeadline({}, '2m', 1000)).toBe(1000 + 120_000);
    expect(resolveDeadline({ deadline: 42 }, '')).toBe(42);
    expect(() => resolveDeadline({}, '')).toThrow(/no deadline/);
  });

  it('holds until the deadline while everything is alive', async () => {
    writeState({ leader: 1, followers: [2] }, t.home);
    t.inputs({ until: '300ms', watch: 'all' });
    const started = Date.now();
    await main({ pollMs: 20, heartbeatMs: 50, isAlive: () => true });
    expect(Date.now() - started).toBeGreaterThanOrEqual(280);
    expect(console.log).toHaveBeenCalledWith('[keep-alive] deadline reached');
    expect(console.log.mock.calls.some(([m]) => /alive; \d+ min remaining/.test(m))).toBe(true);
  });

  it('fails fast when a watched follower dies', async () => {
    writeState(
      { leader: 1, followers: [2], followerLogs: [null], deadline: Date.now() + 60_000 },
      t.home
    );
    t.inputs({ watch: 'followers' });
    await expect(main({ pollMs: 10, isAlive: (pid) => pid === 1 })).rejects.toThrow(
      /follower pid 2 exited before the deadline/
    );
  });

  it('ignores followers when only the leader is watched', async () => {
    writeState({ leader: 1, followers: [2] }, t.home);
    t.inputs({ until: '100ms', watch: 'leader' });
    await expect(main({ pollMs: 10, isAlive: (pid) => pid === 1 })).resolves.toBeUndefined();
  });

  it('rejects an unknown watch value', async () => {
    t.inputs({ until: '1s', watch: 'everyone' });
    await expect(main()).rejects.toThrow(/watch must be/);
  });
});
