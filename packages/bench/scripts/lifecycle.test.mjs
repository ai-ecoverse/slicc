import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  bootLane,
  createJournal,
  createLock,
  createRecycler,
  currentLeader,
  laneEnv,
  redact,
  runNode,
  stopLeader,
} from './lifecycle.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'bench-life-'));

describe('runNode', () => {
  it('runs a script with the given environment and keeps its output', async () => {
    const dir = tmp();
    const script = join(dir, 's.mjs');
    writeFileSync(
      script,
      'console.log("out", process.env.X); console.error("err"); process.exit(3);'
    );
    const r = await runNode(script, { env: { ...process.env, X: 'y' } });
    expect(r.status).toBe(3);
    expect(r.output).toContain('out y');
    expect(r.output).toContain('err');
  });

  it('kills a script that outlives its timeout', async () => {
    const dir = tmp();
    const script = join(dir, 'hang.mjs');
    writeFileSync(script, 'setInterval(() => {}, 1000);');
    expect((await runNode(script, { env: process.env, timeoutMs: 100 })).status).toBe(1);
  });
});

describe('currentLeader', () => {
  it('reads the running leader from the state file', () => {
    expect(
      currentLeader(() => ({ joinUrl: 'https://x/join/a', startedAt: 't', sliccVersion: '6.1' }))
    ).toEqual({ url: 'https://x/join/a', startedAt: 't', sliccVersion: '6.1' });
    expect(currentLeader(() => ({ joinUrl: 'https://x/join/a' }))).toEqual({
      url: 'https://x/join/a',
      startedAt: null,
      sliccVersion: null,
    });
    expect(currentLeader(() => ({ joinUrl: 'u', startedAt: 0 })).startedAt).toBe(
      '1970-01-01T00:00:00.000Z'
    );
    expect(currentLeader(() => null)).toBeNull();
  });
});

describe('createRecycler', () => {
  it('stops, starts, and returns the new leader with its URL masked', async () => {
    const run = vi.fn(async () => ({ status: 0, output: '' }));
    const mask = vi.fn();
    const recycle = createRecycler({
      scriptsDir: '/gw/scripts',
      env: { A: '1' },
      run,
      mask,
      read: () => ({ joinUrl: 'https://x/join/new', startedAt: 's2' }),
    });
    expect(await recycle()).toEqual({
      url: 'https://x/join/new',
      startedAt: 's2',
      sliccVersion: null,
    });
    expect(run.mock.calls.map((c) => c[0])).toEqual([
      '/gw/scripts/stop-leader.mjs',
      '/gw/scripts/start-leader.mjs',
    ]);
    const env = run.mock.calls[1][1].env;
    expect(env.A).toBe('1');
    expect(env.GITHUB_OUTPUT).toMatch(/bench-leader-.*\/output$/);
    expect(existsSync(env.GITHUB_OUTPUT)).toBe(false);
    expect(mask).toHaveBeenCalledWith('https://x/join/new');
  });

  it("wipes the old leader's profile between stop and start", async () => {
    const profileDir = tmp();
    writeFileSync(join(profileDir, 'scoops.db'), 'old state');
    const seen = [];
    const run = vi.fn(async (script) => {
      seen.push([script.split('/').pop(), existsSync(profileDir)]);
      return { status: 0, output: '' };
    });
    let reads = 0;
    const read = () => (reads++ === 0 ? { joinUrl: 'u0', profileDir } : { joinUrl: 'u1' });
    await createRecycler({ scriptsDir: '/s', run, read, mask: () => {} })();
    expect(seen).toEqual([
      ['stop-leader.mjs', true],
      ['start-leader.mjs', false],
    ]);
    const noProfile = createRecycler({
      scriptsDir: '/s',
      run: async () => ({ status: 0, output: '' }),
      read: () => ({ joinUrl: 'u' }),
      mask: () => {},
    });
    await expect(noProfile()).resolves.toMatchObject({ url: 'u' });
  });

  it('fails loudly when a script fails or no leader comes up', async () => {
    const read = () => ({ joinUrl: 'u' });
    const stopFails = createRecycler({
      scriptsDir: '/s',
      run: async () => ({ status: 2, output: 'no state' }),
      read,
      mask: () => {},
    });
    await expect(stopFails()).rejects.toThrow('stop-leader exited 2: no state');
    const run = vi
      .fn()
      .mockResolvedValueOnce({ status: 0, output: '' })
      .mockResolvedValueOnce({ status: 1, output: 'chrome did not start' });
    await expect(createRecycler({ scriptsDir: '/s', run, read, mask: () => {} })()).rejects.toThrow(
      'start-leader exited 1: chrome did not start'
    );
    const noUrl = createRecycler({
      scriptsDir: '/s',
      run: async () => ({ status: 0, output: '' }),
      read: () => ({}),
      mask: () => {},
    });
    await expect(noUrl()).rejects.toThrow(/without a join URL/);
  });

  it('masks through the job log only in Actions', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const base = {
      scriptsDir: '/s',
      run: async () => ({ status: 0, output: '' }),
      read: () => ({ joinUrl: 'https://x/join/z' }),
    };
    await createRecycler({ ...base, env: { GITHUB_ACTIONS: 'true' } })();
    expect(log).toHaveBeenCalledWith('::add-mask::https://x/join/z');
    log.mockClear();
    await createRecycler({ ...base, env: {} })();
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });
});

describe('redact and the journal', () => {
  it('removes join URLs and tokens', () => {
    expect(
      redact('dial https://w/join/abc123?x=1 failed; controller /controller/k9 ok', [
        'https://w/join/abc123',
      ])
    ).toBe('dial <join-url>?x=1 failed; controller /controller/<token> ok');
    expect(redact(undefined)).toBe('');
    expect(redact('/webhook/zz', [null])).toBe('/webhook/<token>');
  });

  it('writes calls, events and redacted dial diagnostics', () => {
    const dir = tmp();
    const url = 'https://w/join/secret';
    const journal = createJournal(dir, { urls: () => [url], now: () => 0 });
    journal.call({ call: 'exec ls', status: 0, ms: 5 });
    journal.call({
      call: 'exec rm',
      status: 1,
      stderr: `could not dial ${url}`,
      diagnostics: [`ice to ${url} failed`, 'again'],
    });
    journal.event('task', { task_id: 't1' });
    journal.event('end');
    const calls = readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(calls[0]).toEqual({ call: 'exec ls', status: 0, ms: 5 });
    expect(calls[1].stderr).toBe('could not dial <join-url>');
    expect(calls[1].diagnostics).toBe('diagnostics/001-exec-rm.log');
    expect(readFileSync(join(dir, calls[1].diagnostics), 'utf8')).toBe(
      'ice to <join-url> failed\n--- next attempt ---\nagain'
    );
    const events = readFileSync(join(dir, 'events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse);
    expect(events).toEqual([
      { at: '1970-01-01T00:00:00.000Z', type: 'task', task_id: 't1' },
      { at: '1970-01-01T00:00:00.000Z', type: 'end' },
    ]);
    expect(readFileSync(join(dir, 'calls.jsonl'), 'utf8')).not.toContain('secret');
  });

  it('marks events in the leader log, and carries on without one', () => {
    const dir = tmp();
    const leaderLog = join(dir, 'leader.log');
    writeFileSync(leaderLog, 'boot\n');
    const journal = createJournal(dir, { now: () => 0, leaderLog });
    journal.event('task', { task_id: 't1' });
    journal.event('leader-restart');
    expect(readFileSync(leaderLog, 'utf8')).toBe(
      'boot\n[bench-event] 1970-01-01T00:00:00.000Z task t1\n[bench-event] 1970-01-01T00:00:00.000Z leader-restart\n'
    );
    createJournal(dir, { leaderLog: join(dir, 'missing', 'leader.log') }).event('end');
    expect(existsSync(join(dir, 'missing'))).toBe(false);
  });
});

describe('lanes', () => {
  it('runs one locked task at a time, and keeps going after a failure', async () => {
    const lock = createLock();
    const order = [];
    const slow = (name, ms, fail) => () =>
      new Promise((resolve, reject) =>
        setTimeout(() => {
          order.push(name);
          fail ? reject(new Error(name)) : resolve(name);
        }, ms)
      );
    const results = await Promise.allSettled([
      lock(slow('a', 30)),
      lock(slow('b', 1, true)),
      lock(slow('c', 1)),
    ]);
    expect(order).toEqual(['a', 'b', 'c']);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
  });

  it('gives each lane its own home and port', () => {
    expect(laneEnv(2, { SLICC_GW_HOME: '/h', BENCH_LEADER_BASE_PORT: '5800' })).toEqual({
      SLICC_GW_HOME: '/h-lane2',
      INPUT_PORT: '5802',
    });
    expect(laneEnv(0, { RUNNER_TEMP: '/r' })).toEqual({
      SLICC_GW_HOME: '/r/slicc-gw-lane0',
      INPUT_PORT: '5710',
    });
    expect(laneEnv(1, {}).SLICC_GW_HOME).toMatch(/slicc-gw-lane1$/);
  });

  it('boots a lane through the lock and stops it with the stop script', async () => {
    const run = vi.fn(async () => ({ status: 0, output: '' }));
    const locked = [];
    const lock = (fn) => {
      locked.push(true);
      return fn();
    };
    const calls = [];
    const lane = await bootLane(1, {
      scriptsDir: '/s',
      env: { SLICC_GW_HOME: '/h', A: 'x' },
      run,
      lock,
      read: () => ({ joinUrl: 'https://w/join/l1', startedAt: 0, sliccVersion: '9.9' }),
      makeLeader: (o) => {
        o.onCall({ call: 'exec ls' });
        return { url: o.url };
      },
      onCall: (e) => calls.push(e),
    });
    expect(lane).toMatchObject({
      leader: { url: 'https://w/join/l1' },
      startedAt: '1970-01-01T00:00:00.000Z',
      sliccVersion: '9.9',
      leaderLog: '/h-lane1/leader.log',
    });
    expect(calls).toEqual([{ call: 'exec ls', lane: 1 }]);
    expect(run.mock.calls[1][1].env).toMatchObject({
      SLICC_GW_HOME: '/h-lane1',
      INPUT_PORT: '5711',
      A: 'x',
    });
    await lane.recycle();
    await lane.stop();
    expect(run.mock.calls.at(-1)[0]).toBe('/s/stop-leader.mjs');
    expect(locked).toHaveLength(3);
    await expect(
      stopLeader({ scriptsDir: '/s', env: {}, run: async () => ({ status: 3, output: 'gone' }) })
    ).rejects.toThrow('stop-leader exited 3: gone');
  });

  it("restarts a lane that was handed another lane's join URL, and gives up the second time", async () => {
    // Each start-leader run hands out the next URL; the recycler reads the state file twice.
    const boot = (claims, urls) => {
      let current = null;
      return bootLane(1, {
        scriptsDir: '/s',
        env: { SLICC_GW_HOME: '/h' },
        run: async (script) => {
          if (script.endsWith('start-leader.mjs')) current = urls.shift();
          return { status: 0, output: '' };
        },
        claims,
        read: () => ({ joinUrl: current, startedAt: 0 }),
        makeLeader: (o) => o,
      });
    };
    const claims = new Map([[0, 'https://w/join/l0']]);
    const urls = [
      'https://w/join/l0',
      'https://w/join/l1',
      'https://w/join/l0',
      'https://w/join/l0',
    ];
    const lane = await boot(claims, urls);
    expect(lane.leader.url).toBe('https://w/join/l1');
    expect(claims.get(1)).toBe('https://w/join/l1');
    await expect(lane.recycle()).rejects.toThrow("lane 1 was handed lane 0's join URL twice");
    await lane.stop();
    expect(claims.has(1)).toBe(false);
    const own = new Map([[1, 'https://w/join/old']]);
    await boot(own, ['https://w/join/old']);
    expect(own.get(1)).toBe('https://w/join/old');
  });

  it("marks events in each lane's own leader log", () => {
    const dir = tmp();
    const logs = { 0: join(dir, 'l0.log'), 1: join(dir, 'l1.log') };
    writeFileSync(logs[0], '');
    writeFileSync(logs[1], '');
    const journal = createJournal(dir, {
      now: () => 0,
      leaderLog: (d) => logs[d.lane ?? 0] ?? null,
    });
    journal.event('task', { lane: 1, task_id: 't' });
    journal.event('start');
    journal.event('x', { lane: 7 });
    expect(readFileSync(logs[1], 'utf8')).toContain('task t');
    expect(readFileSync(logs[0], 'utf8')).toContain('start');
  });
});
