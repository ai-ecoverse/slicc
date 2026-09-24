import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { callLabel, createLeader, DEFAULT_CALL_TIMEOUT_MS, runProcess } from './executors.mjs';

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
    // 130 either way: the trap's own exit, or death by SIGINT before the trap was set. SIGTERM
    // would be 143. The trap's output is not asserted, because that races the shell's startup.
    expect(r).toMatchObject({ status: 130, timedOut: true });
  });

  it('terminates other verbs at the timeout, even when a child holds the pipes', async () => {
    const cli = fakeCli('sleep 5');
    const r = await runProcess(cli, [], { timeoutMs: 100 });
    expect(r.timedOut).toBe(true);
    expect(r.status).not.toBe(0);
  });
});
