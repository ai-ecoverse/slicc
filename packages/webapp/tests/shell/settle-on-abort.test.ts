/**
 * An aborted command settles at once, so a slow one cannot poison the
 * just-bash execution scope it shares with a long-lived caller (#3530: ^C on a
 * command GNU bash ran through the shell left every later one aborting).
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const run = vi.hoisted(() => vi.fn());
vi.mock('../../src/shell/supplemental-commands/wasm/run.js', () => ({ runWasmCommand: run }));

import { VirtualFS } from '../../src/fs/index.js';
import { AlmostBashShellHeadless } from '../../src/shell/almost-bash-shell-headless.js';
import { settleOnAbort } from '../../src/shell/settle-on-abort.js';

type ExecResult = { stdout: string; stderr: string; exitCode: number };
type Ctx = {
  cwd: string;
  exec: (cmd: string, opts: { cwd: string; signal?: AbortSignal }) => Promise<ExecResult>;
};

const DONE: ExecResult = { stdout: 'done\n', stderr: '', exitCode: 0 };

describe('settleOnAbort', () => {
  it("passes the command's result through", async () => {
    await expect(settleOnAbort(async () => DONE, new AbortController().signal)).resolves.toBe(DONE);
    await expect(settleOnAbort(async () => DONE, undefined)).resolves.toBe(DONE);
  });

  it('settles as aborted when the signal aborts, however long the command runs', async () => {
    const abort = new AbortController();
    const settled = settleOnAbort(() => new Promise<ExecResult>(() => undefined), abort.signal);
    abort.abort();
    await expect(settled).resolves.toMatchObject({ exitCode: 130 });
  });

  it('does not start a command whose signal already aborted', async () => {
    const command = vi.fn(async () => DONE);
    await expect(settleOnAbort(command, AbortSignal.abort())).resolves.toMatchObject({
      exitCode: 130,
    });
    expect(command).not.toHaveBeenCalled();
  });

  it('stops listening once the command settles', async () => {
    const abort = new AbortController();
    const remove = vi.spyOn(abort.signal, 'removeEventListener');
    await settleOnAbort(async () => DONE, abort.signal);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});

describe('an aborted nested command', () => {
  let fs: VirtualFS;

  beforeEach(async () => {
    run.mockReset();
    fs = await VirtualFS.create({ dbName: `test-settle-${Math.random()}`, wipe: true });
  });

  afterEach(async () => {
    await fs.dispose();
  });

  it("leaves its caller's later commands running", async () => {
    // `wasm outer` stands in for the login shell: it runs a command that
    // ignores its abort (`wasm hang`, like `mount` at its prompt), kills it,
    // then runs another.
    run.mockImplementation(async (args: string[], ctx: Ctx) => {
      if (args[0] === 'hang') return new Promise(() => undefined);
      const kill = new AbortController();
      setTimeout(() => kill.abort(), 20);
      const hung = await ctx.exec('wasm hang', { cwd: ctx.cwd, signal: kill.signal });
      // Past just-bash's 100 ms cleanup window, when it would poison the scope.
      await new Promise((resolve) => setTimeout(resolve, 150));
      const next = await ctx.exec('echo after', { cwd: ctx.cwd });
      return { stdout: `${hung.exitCode} ${next.stdout}`, stderr: next.stderr, exitCode: 0 };
    });
    const shell = new AlmostBashShellHeadless({ fs });

    const res = await shell.executeCommand('wasm outer');

    expect(res.stderr).toBe('');
    expect(res.stdout).toBe('124 after\n');
  });
});
