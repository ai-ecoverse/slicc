import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setup } from '../tests/helpers.mjs';
import { main } from './follow.mjs';
import { isAlive, readState, statePath, terminate, writeState } from './gh-io.mjs';

describe('follow', () => {
  let t;
  beforeEach(() => {
    t = setup();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(async () => {
    for (const pid of readState(t.home)?.followers ?? []) await terminate(pid, 300);
    t.teardown();
    vi.restoreAllMocks();
  });

  it('starts a detached follower, waits for connected, and records it in the state', async () => {
    writeState({ leader: 4242, followers: [], followerLogs: [] }, t.home);
    t.inputs({ runner: 'docker exec -i box sh -c', 'connect-timeout': '5s' });
    const r = await main({ pollMs: 20 });
    expect(r.connected).toBe(true);
    expect(isAlive(r.pid)).toBe(true);
    const state = readState(t.home);
    expect(state.leader).toBe(4242);
    expect(state.followers).toEqual([r.pid]);
    expect(state.followerLogs).toEqual([join(t.home, 'follower-1.log')]);
    expect(readFileSync(r.logPath, 'utf8')).toContain('connected');
    expect(t.outputs()).toEqual({ pid: String(r.pid), 'log-path': r.logPath, connected: 'true' });
    expect(t.calls()[0].rest).toEqual([
      '--plain',
      '--no-banner',
      'docker',
      'exec',
      '-i',
      'box',
      'sh',
      '-c',
    ]);
  });

  it('works without a prior state file and supports eval mode', async () => {
    t.inputs({ eval: 'true', 'eval-quiet': '2s', runner: 'python -i' });
    const r = await main({ pollMs: 20 });
    expect(readState(t.home).followers).toEqual([r.pid]);
    expect(t.calls()[0].rest).toEqual([
      '--plain',
      '--no-banner',
      '--eval',
      '--eval-quiet',
      '2s',
      'python',
      '-i',
    ]);
  });

  it('does not replace unreadable leader and credential state with follower-only state', async () => {
    const leaderState = {
      leader: 4242,
      secretsFile: '/runner/secrets.env',
      profileDir: '/runner/profile',
      followers: [],
      followerLogs: [],
    };
    writeState(leaderState, t.home);
    const original = readFileSync(statePath(t.home), 'utf8');
    const partial = '{ "leader": 4242,';
    writeFileSync(statePath(t.home), partial);
    try {
      await expect(main({ pollMs: 20 })).rejects.toThrow(/invalid runner state/);
      expect(readFileSync(statePath(t.home), 'utf8')).toBe(partial);
      expect(t.calls()).toEqual([]);
      expect(t.outputs()).toEqual({});
    } finally {
      writeFileSync(statePath(t.home), original);
    }
  });

  it('fails when the follower exits before connecting', async () => {
    process.env.FAKE_SLICC_FOLLOW = 'exit';
    t.inputs({ 'connect-timeout': '5s' });
    await expect(main({ pollMs: 20 })).rejects.toThrow(/exited with status 3 before connecting/);
    expect(readState(t.home)).toBeNull();
  });

  it('warns but keeps a follower that has not logged connected in time', async () => {
    process.env.FAKE_SLICC_FOLLOW = 'silent';
    t.inputs({ 'connect-timeout': '300ms' });
    const r = await main({ pollMs: 20 });
    expect(r.connected).toBe(false);
    expect(isAlive(r.pid)).toBe(true);
    expect(console.log).toHaveBeenCalledWith(
      '::warning::follower has not logged "connected" yet; leaving it running'
    );
  });
});
