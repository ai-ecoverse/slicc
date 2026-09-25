import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  callLabel,
  connectionLost,
  createLeader,
  DEFAULT_CALL_TIMEOUT_MS,
  runProcess,
  unreachable,
} from './executors.mjs';

describe('createLeader', () => {
  it('puts the join URL before every verb, wraps exec, and bounds every call', async () => {
    const run = vi.fn(async () => ({ stdout: 'ok', stderr: '', status: 0, timedOut: false }));
    const leader = createLeader({ url: 'https://x/join/t', cli: '/bin/slicc', run });
    expect(await leader.exec('ls /', { stdin: 'in', timeoutMs: 5 })).toMatchObject({
      stdout: 'ok',
      status: 0,
      leaderDown: false,
    });
    expect(run).toHaveBeenLastCalledWith('/bin/slicc', ['https://x/join/t', 'exec', 'ls /'], {
      stdin: 'in',
      timeoutMs: 5,
    });
    await leader.cli(['prompt', '-'], { stdin: 'task', interrupt: true, timeoutMs: 900_000 });
    expect(run).toHaveBeenLastCalledWith('/bin/slicc', ['https://x/join/t', 'prompt', '-'], {
      stdin: 'task',
      interrupt: true,
      timeoutMs: 900_000,
    });
    await leader.cli(['model', 'claude-sonnet-5']);
    expect(run).toHaveBeenLastCalledWith(
      '/bin/slicc',
      ['https://x/join/t', 'model', 'claude-sonnet-5'],
      { timeoutMs: DEFAULT_CALL_TIMEOUT_MS }
    );
    expect(leader.url).toBe('https://x/join/t');
    leader.setUrl('https://x/join/u');
    await leader.exec('true');
    expect(run.mock.lastCall[1][0]).toBe('https://x/join/u');
    expect(() => leader.setUrl('')).toThrow(/join URL/);
  });

  it('retries dial failures with debug output, logs every call, and flags a dead leader', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '', stderr: 'tray connect timed out', status: 1 })
      .mockResolvedValueOnce({ stdout: 'fine', stderr: '', status: 0 });
    const onCall = vi.fn();
    const leader = createLeader({ url: 'https://x', run, retryDelayMs: 0, onCall });
    expect((await leader.cli(['new-session', '--erase'])).stdout).toBe('fine');
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0][2].env).toBeUndefined();
    expect(run.mock.calls[1][2].env).toEqual({ SLICC_DEBUG: '1' });
    expect(onCall).toHaveBeenLastCalledWith(
      expect.objectContaining({
        call: 'new-session --erase',
        status: 0,
        attempts: 2,
        leaderDown: false,
        timedOut: false,
      })
    );
    expect(onCall.mock.lastCall[0].diagnostics).toBeUndefined();

    const failing = vi.fn(async () => ({ stdout: '', stderr: 'no model matches', status: 1 }));
    const log = vi.fn();
    const r = await createLeader({
      url: 'https://x',
      run: failing,
      retryDelayMs: 0,
      onCall: log,
    }).cli(['model', 'x']);
    expect(r).toMatchObject({ status: 1, leaderDown: false });
    expect(failing).toHaveBeenCalledTimes(1);
    expect(log.mock.lastCall[0]).toMatchObject({ call: 'model x', stderr: 'no model matches' });

    const alwaysDown = vi.fn(async (_cli, _args, opts) => ({
      stdout: '',
      stderr: opts.env?.SLICC_DEBUG ? 'debug: ice failed\nsignaling failed' : 'signaling failed',
      status: 1,
    }));
    const down = vi.fn();
    const dead = await createLeader({
      url: 'https://x',
      run: alwaysDown,
      retryDelayMs: 0,
      onCall: down,
    }).exec('rm -rf /tmp/x');
    expect(dead).toMatchObject({ status: 1, leaderDown: true });
    expect(alwaysDown).toHaveBeenCalledTimes(3);
    expect(down.mock.lastCall[0]).toMatchObject({ call: 'exec rm', attempts: 3, leaderDown: true });
    expect(down.mock.lastCall[0].diagnostics).toEqual([
      'debug: ice failed\nsignaling failed',
      'debug: ice failed\nsignaling failed',
    ]);
  });

  it('treats a leader that never opened a terminal as down, and retries', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: '',
        stderr: 'slicc exec: terminal-open timed out after 10000ms',
        status: 1,
      })
      .mockResolvedValueOnce({ stdout: 'ran', stderr: '', status: 0 });
    const leader = createLeader({ url: 'https://x', run, retryDelayMs: 0 });
    expect(await leader.exec('rm -rf /tmp/x')).toMatchObject({ stdout: 'ran', leaderDown: false });
    expect(run.mock.calls[1][2].env).toEqual({ SLICC_DEBUG: '1' });
    expect(unreachable(1, 'terminal-open timed out after 10000ms')).toBe(true);
    expect(unreachable(0, 'terminal-open timed out')).toBe(false);
    expect(unreachable(1, 'no model matches')).toBe(false);
  });

  it('marks a call whose connection closed as leader-down, without repeating it', async () => {
    const run = vi.fn(async () => ({
      stdout: '',
      stderr: 'slicc new-session: io: read/write on closed pipe\n',
      status: 1,
    }));
    const onCall = vi.fn();
    const leader = createLeader({ url: 'https://x', run, retryDelayMs: 0, onCall });
    expect(await leader.cli(['new-session', '--erase'])).toMatchObject({
      status: 1,
      leaderDown: true,
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(onCall.mock.lastCall[0]).toMatchObject({ attempts: 1, leaderDown: true });
    expect(connectionLost(0, 'read/write on closed pipe')).toBe(false);
    expect(connectionLost(1, 'no model matches')).toBe(false);
  });

  it('names calls without their arguments', () => {
    expect(callLabel(['exec', '  base64 /tmp/secret.png'])).toBe('exec base64');
    expect(callLabel(['exec'])).toBe('exec ');
    expect(callLabel(['model', 'claude-sonnet-5'])).toBe('model claude-sonnet-5');
  });

  it('needs a join URL', () => {
    expect(() => createLeader({ url: '' })).toThrow(/join URL/);
  });
});

function fakeCli(script) {
  const dir = mkdtempSync(join(tmpdir(), 'bench-cli-'));
  const cli = join(dir, 'fake-slicc');
  writeFileSync(cli, `#!/bin/sh\n${script}\n`);
  chmodSync(cli, 0o755);
  return cli;
}

describe('runProcess', () => {
  it('survives a CLI that exits without reading its stdin', async () => {
    const cli = fakeCli('echo early; exit 1');
    const r = await runProcess(cli, [], { stdin: 'x'.repeat(4 * 1024 * 1024) });
    expect(r).toMatchObject({ stdout: 'early\n', status: 1 });
  });

  it('passes extra environment to the CLI', async () => {
    const cli = fakeCli('echo "debug=$SLICC_DEBUG tui=$SLICC_NO_TUI"');
    expect((await runProcess(cli, [], { env: { SLICC_DEBUG: '1' } })).stdout).toBe(
      'debug=1 tui=1\n'
    );
  });

  it('passes stdin and reports stdout, stderr and the exit status', async () => {
    const cli = fakeCli('cat\necho "args:$1:$2" >&2\nexit 3');
    expect(await runProcess(cli, ['https://x', 'exec'], { stdin: 'hello' })).toEqual({
      stdout: 'hello',
      stderr: 'args:https://x:exec\n',
      status: 3,
      timedOut: false,
    });
  });

  it('interrupts a prompt at the timeout so the CLI can send the leader an abort', async () => {
    const cli = fakeCli("trap 'echo aborted; exit 130' INT\nwhile true; do sleep 0.05; done");
    const r = await runProcess(cli, [], { timeoutMs: 200, interrupt: true });

    expect(r).toMatchObject({ status: 130, timedOut: true });
  });

  it('stops the CLI when its signal aborts, before or during the call', async () => {
    const cli = fakeCli("trap 'exit 130' INT\nwhile true; do sleep 0.05; done");
    const ac = new AbortController();
    const running = runProcess(cli, [], { interrupt: true, signal: ac.signal });
    setTimeout(() => ac.abort(), 150);
    expect(await running).toMatchObject({ status: 130, timedOut: false, aborted: true });
    const pre = new AbortController();
    pre.abort();
    expect(await runProcess(cli, [], { signal: pre.signal })).toMatchObject({ aborted: true });
    const done = new AbortController();
    const quick = fakeCli('echo ok');
    expect(await runProcess(quick, [], { signal: done.signal })).toEqual({
      stdout: 'ok\n',
      stderr: '',
      status: 0,
      timedOut: false,
    });
    done.abort();
  });

  it('terminates other verbs at the timeout, even when a child holds the pipes', async () => {
    const cli = fakeCli('sleep 5');
    const r = await runProcess(cli, [], { timeoutMs: 100 });
    expect(r.timedOut).toBe(true);
    expect(r.status).not.toBe(0);
  });
});
