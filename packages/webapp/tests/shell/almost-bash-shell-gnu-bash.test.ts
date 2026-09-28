/**
 * The agent's shell on GNU bash (#3530): once a package provides `bash`, a
 * shell built with `gnuBash` runs each command as `bash -c` in the wasm realm
 * and carries the run's cwd and exported environment into the next one.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const run = vi.hoisted(() => vi.fn());
vi.mock('../../src/shell/supplemental-commands/wasm/run.js', () => ({ runWasmCommand: run }));

import { VirtualFS } from '../../src/fs/index.js';
import { AlmostBashShellHeadless } from '../../src/shell/almost-bash-shell-headless.js';
import { GLOBAL_NODE_MODULES } from '../../src/shell/ipk/global-prefix.js';
import type { NativeGate } from '../../src/shell/supplemental-commands/wasm/launch.js';

const PKG = `${GLOBAL_NODE_MODULES}/wasm-bash`;

async function installBash(fs: VirtualFS): Promise<void> {
  await fs.mkdir(`${PKG}/bin`, { recursive: true });
  await fs.writeFile(
    `${PKG}/package.json`,
    JSON.stringify({
      name: 'wasm-bash',
      slicc: { commands: { bash: { glue: 'bin/bash', wasm: 'bin/bash.wasm' } } },
    })
  );
}

type RunCtx = { exportedEnv: Record<string, string>; cwd: string };
type RunOptions = { onOutput?: (text: string) => void; gate?: NativeGate };

/** What the hook's EXIT trap would write. */
function state(status: number, pipe: string, cwd: string, env: Record<string, string>): string {
  const vars = Object.entries(env).map(([k, v]) => `${k}=${v}\0`);
  return `${status}\0${pipe}\0${cwd}\0${vars.join('')}`;
}

describe('AlmostBashShellHeadless on GNU bash', () => {
  let fs: VirtualFS;

  beforeEach(async () => {
    run.mockReset();
    fs = await VirtualFS.create({ dbName: `test-gnu-bash-${Math.random()}`, wipe: true });
  });

  afterEach(async () => {
    await fs.dispose();
  });

  /** A fake bash: writes the state the hook would, and answers `stdout` (latin1 bytes). */
  function fakeBash(stdout: string, leave: (ctx: RunCtx) => string | null) {
    run.mockImplementation(async (_args: string[], ctx: RunCtx, options: RunOptions) => {
      const text = leave(ctx);
      if (text !== null) await fs.writeFile(ctx.exportedEnv.SLICC_BASH_STATE!, text);
      options.onOutput?.('live ');
      const bytes = new TextEncoder().encode(stdout);
      return {
        stdout: String.fromCharCode(...bytes),
        stderr: '',
        exitCode: 3,
        stdoutKind: 'bytes',
      };
    });
  }

  it('runs the command as bash -c and carries cwd and exports into the next run', async () => {
    await installBash(fs);
    await fs.mkdir('/workspace/sub', { recursive: true });
    const shell = new AlmostBashShellHeadless({ fs, gnuBash: true, env: { GONE: '1' } });
    fakeBash('café\n', (ctx) =>
      state(3, '1 0 3', '/workspace/sub', {
        ...ctx.exportedEnv,
        NEW: 'x\ny',
        GONE: '',
        SHLVL: '1',
        _: '/usr/bin/true',
      }).replace('GONE=\0', '')
    );
    const tee: string[] = [];
    const res = await shell.executeCommand(
      'cd sub; export NEW; false | true | (exit 3)',
      undefined,
      7,
      undefined,
      {
        capturePipeStatus: true,
        onOutput: (chunk) => tee.push(chunk),
      }
    );
    expect(run.mock.calls[0]![0]).toEqual([
      'bash',
      '-c',
      'cd sub; export NEW; false | true | (exit 3)',
    ]);
    const first = run.mock.calls[0]![1] as RunCtx;
    expect(first.exportedEnv.BASH_ENV).toMatch(/\.slicc-bash-env\.sh$/);
    expect(first.exportedEnv.__SLICC_RUN_PID).toBe('7');
    expect(res).toMatchObject({ stdout: 'café\n', exitCode: 3, pipeStatus: [1, 0, 3] });
    expect(tee).toEqual(['live ']);
    expect(await fs.exists(first.exportedEnv.SLICC_BASH_STATE!)).toBe(false); // cleaned up

    fakeBash('', () => null); // a run that leaves no state keeps the shell's
    await shell.executeCommand('pwd');
    const second = run.mock.calls[1]![1] as RunCtx;
    expect(second.cwd).toBe('/workspace/sub');
    expect(second.exportedEnv.NEW).toBe('x\ny');
    expect(second.exportedEnv.GONE).toBeUndefined();
    expect(second.exportedEnv.SHLVL).toBeUndefined();
    expect(second.exportedEnv._).toBeUndefined();
    expect(second.exportedEnv.__SLICC_RUN_PID).toBeUndefined();
    await shell.executeCommand('true');
    expect((run.mock.calls[2]![1] as RunCtx).cwd).toBe('/workspace/sub');
  });

  it('stays on just-bash without the option, without bash installed, or when opted out', async () => {
    const plain = new AlmostBashShellHeadless({ fs, gnuBash: true });
    expect((await plain.executeCommand('echo just')).stdout).toBe('just\n');
    await installBash(fs);
    const agentless = new AlmostBashShellHeadless({ fs });
    expect((await agentless.executeCommand('echo just')).stdout).toBe('just\n');
    const optedOut = new AlmostBashShellHeadless({
      fs,
      gnuBash: true,
      env: { SLICC_SHELL: 'just-bash' },
    });
    expect((await optedOut.executeCommand('echo just')).stdout).toBe('just\n');
    expect(run).not.toHaveBeenCalled();
  });

  it('runs a shell restricted to a command list on GNU bash, gating what bash runs', async () => {
    await installBash(fs);
    const shell = new AlmostBashShellHeadless({ fs, gnuBash: true, allowedCommands: ['echo'] });
    fakeBash('', () => null);
    await shell.executeCommand('echo hi; rm -rf /');
    expect(run.mock.calls[0]![0]).toEqual(['bash', '-c', 'echo hi; rm -rf /']);
    const gate = (run.mock.calls[0]![2] as RunOptions).gate!;
    expect(await gate('rm', ['-rf', '/'], {})).toEqual({
      stderr: 'bash: rm: command not found\n',
      exitCode: 127,
    });
    expect(await gate('echo', ['hi'], {})).toBeNull();
  });

  it('gates what a wasm program runs with the shell’s command list', async () => {
    const shell = new AlmostBashShellHeadless({ fs, allowedCommands: ['wasm', 'echo'] });
    run.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    await shell.executeCommand('wasm tool.js');
    const gate = (run.mock.calls[0]![2] as RunOptions).gate!;
    expect(await gate('rm', ['-rf', '/'], {})).toEqual({
      stderr: 'bash: rm: command not found\n',
      exitCode: 127,
    });
    expect(await gate('echo', ['hi'], {})).toBeNull();
  });
});
