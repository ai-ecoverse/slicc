/**
 * Wasm programs of installed packages (#3530) as shell commands: registered
 * by name, run through the wasm realm, never shadowing a built-in.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const run = vi.hoisted(() => vi.fn());
vi.mock('../../src/shell/supplemental-commands/wasm/run.js', () => ({ runWasmCommand: run }));

import { VirtualFS } from '../../src/fs/index.js';
import { AlmostBashShellHeadless } from '../../src/shell/almost-bash-shell-headless.js';
import { GLOBAL_NODE_MODULES } from '../../src/shell/ipk/global-prefix.js';

const PKG = `${GLOBAL_NODE_MODULES}/wasm-tools`;

async function installTools(fs: VirtualFS, commands: string[]): Promise<void> {
  await fs.mkdir(`${PKG}/bin`, { recursive: true });
  const decl = Object.fromEntries(
    commands.map((c) => [c, { glue: 'bin/multi', wasm: 'bin/multi.wasm', argv0: `x-${c}` }])
  );
  await fs.writeFile(
    `${PKG}/package.json`,
    JSON.stringify({ name: 'wasm-tools', slicc: { commands: decl } })
  );
}

describe('AlmostBashShellHeadless installed wasm commands', () => {
  let fs: VirtualFS;

  beforeEach(async () => {
    run.mockReset();
    run.mockResolvedValue({ stdout: 'from-wasm\n', stderr: '', exitCode: 0 });
    fs = await VirtualFS.create({ dbName: `test-wasm-cmd-${Math.random()}`, wipe: true });
  });

  afterEach(async () => {
    await fs.dispose();
  });

  it('runs an installed program by name with its glue, module and argv0', async () => {
    await installTools(fs, ['frob']);
    const shell = new AlmostBashShellHeadless({ fs });
    await shell.syncJshCommands();
    const res = await shell.executeCommand('frob a b');
    expect(res.stdout).toBe('from-wasm\n');
    expect(run.mock.calls[0][0]).toEqual([
      '--argv0',
      'x-frob',
      '--module',
      `${PKG}/bin/multi.wasm`,
      `${PKG}/bin/multi`,
      'a',
      'b',
    ]);
  });

  it('passes manifest arguments before the caller arguments', async () => {
    await fs.mkdir(`${PKG}/bin`, { recursive: true });
    await fs.writeFile(
      `${PKG}/package.json`,
      JSON.stringify({
        name: 'wasm-tools',
        slicc: { abi: 'wasi', commands: { gem: { wasm: 'bin/ruby.wasm', args: ['-S', 'gem'] } } },
      })
    );
    const shell = new AlmostBashShellHeadless({ fs });
    await shell.syncJshCommands();
    await shell.executeCommand('gem --version');
    expect(run.mock.calls[0][0]).toEqual([
      '--argv0',
      'gem',
      '--module',
      `${PKG}/bin/ruby.wasm`,
      `${PKG}/bin/ruby.wasm`,
      '-S',
      'gem',
      '--version',
    ]);
  });

  it('hands a program run by name its own env defaults', async () => {
    await fs.mkdir(`${PKG}/bin`, { recursive: true });
    await fs.writeFile(
      `${PKG}/package.json`,
      JSON.stringify({
        name: 'wasm-tools',
        slicc: {
          env: { MODE: 'pkg' },
          commands: {
            frob: { glue: 'bin/multi', wasm: 'bin/multi.wasm', env: { WHO: 'frob' } },
            zap: { glue: 'bin/multi', wasm: 'bin/multi.wasm', env: { WHO: 'zap' } },
          },
        },
      })
    );
    const shell = new AlmostBashShellHeadless({ fs });
    await shell.syncJshCommands();
    await shell.executeCommand('frob');
    expect(run.mock.calls[0][2].defaults).toEqual({ MODE: 'pkg', WHO: 'frob' });
  });

  it('hands the program the shell’s live catalog: a removal shows at once', async () => {
    await installTools(fs, ['frob']);
    const shell = new AlmostBashShellHeadless({ fs });
    await shell.syncJshCommands();
    await shell.executeCommand('frob');
    const commands = run.mock.calls[0][2].commands as () => Promise<Map<string, unknown>>;
    expect((await commands()).has('frob')).toBe(true);
    await fs.rm(PKG, { recursive: true });
    await shell.syncJshCommands();
    expect((await commands()).has('frob')).toBe(false);
  });

  it('never shadows a built-in of the same name', async () => {
    await installTools(fs, ['cat']);
    await fs.writeFile('/workspace/f', 'builtin-cat\n');
    const shell = new AlmostBashShellHeadless({ fs });
    await shell.syncJshCommands();
    const res = await shell.executeCommand('cat /workspace/f');
    expect(res.stdout).toBe('builtin-cat\n');
    expect(run).not.toHaveBeenCalled();
  });

  it('a .jsh of the same name wins at dispatch', async () => {
    await installTools(fs, ['dual']);
    await fs.writeFile('/workspace/bin/dual.jsh', "console.log('JSH-WON');");
    const shell = new AlmostBashShellHeadless({ fs });
    await shell.syncJshCommands();
    const res = await shell.executeCommand('dual');
    expect(res.stdout).toContain('JSH-WON');
    expect(run).not.toHaveBeenCalled();
  });

  it('answers 127 once the package is gone', async () => {
    await installTools(fs, ['gone']);
    const shell = new AlmostBashShellHeadless({ fs });
    await shell.syncJshCommands();
    await fs.rm(PKG, { recursive: true });
    const res = await shell.executeCommand('gone');
    expect(res.exitCode).toBe(127);
    expect(run).not.toHaveBeenCalled();
  });

  it('`which` reports the glue and package', async () => {
    await installTools(fs, ['frob']);
    const shell = new AlmostBashShellHeadless({ fs });
    await shell.syncJshCommands();
    const res = await shell.executeCommand('which frob');
    expect(res.stdout).toBe(`${PKG}/bin/multi (wasm, wasm-tools)\n`);
  });
});
