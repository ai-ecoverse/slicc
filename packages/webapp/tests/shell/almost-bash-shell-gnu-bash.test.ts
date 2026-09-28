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
type RunOptions = {
  onOutput?: (text: string) => void;
  gate?: NativeGate;
  fds?: ReadonlyArray<readonly [number, { file: { write?: (b: Uint8Array) => unknown } }]>;
};

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

  function fakeBash(stdout: string, leave: (ctx: RunCtx) => string | null) {
    run.mockImplementation(async (_args: string[], ctx: RunCtx, options: RunOptions) => {
      const text = leave(ctx);

      if (text !== null) await options.fds?.[0]?.[1].file.write?.(new TextEncoder().encode(text));
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
    const [args] = run.mock.calls[0]!;
    expect(args.slice(0, 2)).toEqual(['bash', '-c']);
    expect(args[2]).toMatch(/trap .* EXIT; cd sub; export NEW; false \| true \| \(exit 3\)$/);
    const first = run.mock.calls[0]![1] as RunCtx;
    expect(first.exportedEnv.BASH_ENV).toBeUndefined();
    expect(first.exportedEnv.__SLICC_RUN_PID).toBe('7');
    expect(res).toMatchObject({ stdout: 'café\n', exitCode: 3, pipeStatus: [1, 0, 3] });
    expect(tee).toEqual(['live ']);
    expect(await fs.exists('/tmp')).toBe(false);

    fakeBash('', () => null);
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

  it('registers the .jsh commands of a PATH a run exported', async () => {
    await installBash(fs);
    await fs.mkdir('/tools', { recursive: true });
    await fs.writeFile('/tools/frob.jsh', "console.log('frob');");
    const shell = new AlmostBashShellHeadless({ fs, gnuBash: true });
    const sync = vi.spyOn(shell, 'syncJshCommands');
    fakeBash('', (ctx) => state(0, '0', '/', { ...ctx.exportedEnv, PATH: '/tools:/usr/bin' }));
    await shell.executeCommand('export PATH=/tools:$PATH');
    expect(sync).toHaveBeenCalled();
    sync.mockClear();
    fakeBash('', (ctx) => state(0, '0', '/', ctx.exportedEnv));
    await shell.executeCommand('true');
    expect(sync).not.toHaveBeenCalled();
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
    expect(run.mock.calls[0]![0][2]).toMatch(/ EXIT; echo hi; rm -rf \/$/);
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
