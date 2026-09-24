import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createLeader, runProcess } from './executors.mjs';

describe('createLeader', () => {
  it('puts the join URL before every verb and wraps exec', async () => {
    const run = vi.fn(async () => ({ stdout: 'ok', stderr: '', status: 0, timedOut: false }));
    const leader = createLeader({ url: 'https://x/join/t', cli: '/bin/slicc', run });
    expect(await leader.exec('ls /', { stdin: 'in', timeoutMs: 5 })).toMatchObject({
      stdout: 'ok',
      status: 0,
    });
    expect(run).toHaveBeenLastCalledWith('/bin/slicc', ['https://x/join/t', 'exec', 'ls /'], {
      stdin: 'in',
      timeoutMs: 5,
    });
    await leader.cli(['prompt', '-'], { stdin: 'task', interrupt: true });
    expect(run).toHaveBeenLastCalledWith('/bin/slicc', ['https://x/join/t', 'prompt', '-'], {
      stdin: 'task',
      interrupt: true,
    });
    await leader.cli(['model', 'claude-sonnet-5']);
    expect(run).toHaveBeenLastCalledWith(
      '/bin/slicc',
      ['https://x/join/t', 'model', 'claude-sonnet-5'],
      {}
    );
  });

  it('retries dial failures only, and returns other failures as they are', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '', stderr: 'tray connect timed out', status: 1 })
      .mockResolvedValueOnce({ stdout: 'fine', stderr: '', status: 0 });
    const leader = createLeader({ url: 'https://x', run, retryDelayMs: 0 });
    expect((await leader.cli(['new-session', '--erase'])).stdout).toBe('fine');
    expect(run).toHaveBeenCalledTimes(2);
    const failing = vi.fn(async () => ({ stdout: '', stderr: 'no model matches', status: 1 }));
    expect(
      (await createLeader({ url: 'https://x', run: failing, retryDelayMs: 0 }).cli(['model', 'x']))
        .status
    ).toBe(1);
    expect(failing).toHaveBeenCalledTimes(1);
    const alwaysDown = vi.fn(async () => ({ stdout: '', stderr: 'signaling failed', status: 1 }));
    expect(
      (await createLeader({ url: 'https://x', run: alwaysDown, retryDelayMs: 0 }).exec('x')).status
    ).toBe(1);
    expect(alwaysDown).toHaveBeenCalledTimes(3);
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

  it('terminates other verbs at the timeout, even when a child holds the pipes', async () => {
    const cli = fakeCli('sleep 5');
    const r = await runProcess(cli, [], { timeoutMs: 100 });
    expect(r.timedOut).toBe(true);
    expect(r.status).not.toBe(0);
  });
});
