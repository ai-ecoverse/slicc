import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setup, sleep } from '../tests/helpers.mjs';
import { isAlive, writeState } from './gh-io.mjs';
import { chromePidsForProfile, main } from './stop-leader.mjs';

function idle(extraArg = '') {
  const child = spawn('sh', ['-c', 'sleep 30', 'idle', extraArg], { stdio: 'ignore' });
  child.unref();
  return child;
}

describe('stop-leader', () => {
  let t;
  const children = [];
  beforeEach(() => {
    t = setup();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    for (const c of children) c.kill('SIGKILL');
    children.length = 0;
    t.teardown();
    vi.restoreAllMocks();
  });

  it('does nothing without a state file', async () => {
    await main();
    expect(console.log).toHaveBeenCalledWith('[stop-leader] no state file; nothing to stop');
  });

  it('stops followers, the leader, leftover chrome, removes credentials, prints logs', async () => {
    const leader = idle();
    const follower = idle();
    const chrome = idle(`--user-data-dir=${join(t.home, 'profile')}`);
    children.push(leader, follower, chrome);
    await sleep(50);
    const secretsFile = join(t.home, 'secrets.env');
    writeFileSync(secretsFile, 'A=1\n');
    writeFileSync(join(t.root, 'leader.log'), 'boot\nready\n');
    writeFileSync(join(t.root, 'f1.log'), 'connected\n');
    writeState(
      {
        leader: leader.pid,
        followers: [follower.pid, 999999],
        followerLogs: [join(t.root, 'f1.log'), join(t.root, 'missing.log')],
        logPath: join(t.root, 'leader.log'),
        profileDir: join(t.home, 'profile'),
        secretsFile,
      },
      t.home
    );
    const exec = vi.fn(() => `${chrome.pid}\n${process.pid}\n`);
    await main({ graceMs: 2000, exec });
    expect(isAlive(leader.pid)).toBe(false);
    expect(isAlive(follower.pid)).toBe(false);
    expect(isAlive(chrome.pid)).toBe(false);
    expect(existsSync(secretsFile)).toBe(false);
    expect(t.outputs()['log-path']).toBe(join(t.root, 'leader.log'));
    expect(console.log).toHaveBeenCalledWith('::group::leader log (tail)');
    expect(console.log).toHaveBeenCalledWith('::group::follower 1 log (tail)');
  });

  it('reports an already-exited leader', async () => {
    writeState({ leader: 999999, followers: [] }, t.home);
    await main({ exec: () => '' });
    expect(console.log).toHaveBeenCalledWith('[stop-leader] node-server pid=999999 already exited');
  });

  it('chromePidsForProfile parses pgrep output and tolerates failures', () => {
    expect(chromePidsForProfile('', vi.fn())).toEqual([]);
    expect(chromePidsForProfile('/p', () => `12\n${process.pid}\nabc\n`)).toEqual([12]);
    expect(
      chromePidsForProfile('/p', () => {
        throw new Error('no match');
      })
    ).toEqual([]);
  });
});
