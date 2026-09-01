/**
 * Guard for the `time`-keyword hunks of `patches/just-bash+3.4.2.patch` (#2718).
 *
 * just-bash times a pipeline correctly — the clock spans the awaited pipeline,
 * not its dispatch — but it padded every report with `user 0m0.000s` /
 * `sys 0m0.000s`. There is no process accounting in the browser, so those two
 * lines were invented: they made a `real 0m0.003s` line read like a broken
 * clock instead of a genuinely 3 ms pipeline. The patch drops them and keeps
 * `real`.
 *
 * The `real ≥ 50 ms` assertions are the regression the issue asked for: a
 * command whose work is a promise the shell must await has to be inside the
 * measured window, in the pipeline shape (`time cmd | cmd`) that first raised
 * the doubt.
 */
import { Bash, defineCommand } from 'just-bash';
import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../src/fs/index.js';
import { AlmostBashShellHeadless } from '../../src/shell/almost-bash-shell-headless.js';

/** Comfortably above the 50 ms floor the assertions use, so a coarse timer cannot dip under it. */
const WORK_MS = 120;

/** A command whose only work is a timer — the browser-shaped "slow command". */
function slowCommand() {
  return defineCommand('slowcmd', async () => {
    await new Promise((resolve) => setTimeout(resolve, WORK_MS));
    return { stdout: 'done\n', stderr: '', exitCode: 0 };
  });
}

/** Seconds parsed out of a `real\t<m>m<s>s` (keyword) or `real <s>` (`-p`) line. */
function realSeconds(stderr: string): number {
  const keyword = /real\t(\d+)m(\d+\.\d+)s/.exec(stderr);
  if (keyword) return Number(keyword[1]) * 60 + Number(keyword[2]);
  const posix = /real (\d+\.\d+)/.exec(stderr);
  if (!posix) throw new Error(`no real line in ${JSON.stringify(stderr)}`);
  return Number(posix[1]);
}

describe('just-bash time keyword (just-bash@3.4.2 patch)', () => {
  it('measures the whole pipeline, not its dispatch', async () => {
    const bash = new Bash({ customCommands: [slowCommand()] });
    const result = await bash.exec('time slowcmd | wc -l');
    expect(result.exitCode).toBe(0);
    expect(realSeconds(result.stderr)).toBeGreaterThanOrEqual(0.05);
  });

  it('reports only real — no invented user/sys', async () => {
    const bash = new Bash({ customCommands: [slowCommand()] });
    const result = await bash.exec('time slowcmd');
    expect(result.stderr).toMatch(/^\nreal\t\d+m\d+\.\d{3}s\n$/);
    expect(result.stderr).not.toMatch(/user|sys/);
  });

  it('omits user/sys in POSIX mode too', async () => {
    const bash = new Bash({ customCommands: [slowCommand()] });
    const result = await bash.exec('time -p slowcmd');
    expect(result.stderr).toMatch(/^real \d+\.\d{2}\n$/);
    expect(realSeconds(result.stderr)).toBeGreaterThanOrEqual(0.05);
  });
});

describe('time through the SLICC shell', () => {
  let shell: AlmostBashShellHeadless;

  beforeAll(async () => {
    const fs = await VirtualFS.create({ dbName: 'just-bash-time-patch', wipe: true });
    await fs.mkdir('/slow');
    await fs.writeFile('/slow/entry', 'x');
    // Stand in for a mounted directory: `readDirSync` returns null under a
    // mount, so `ls` takes VfsAdapter's async path — the hostfs round trip
    // #2718 was timing.
    const readDir = fs.readDir.bind(fs);
    fs.readDirSync = () => null;
    fs.readDir = async (path: string) => {
      await new Promise((resolve) => setTimeout(resolve, WORK_MS));
      return readDir(path);
    };
    shell = new AlmostBashShellHeadless({ fs });
  });

  it('keeps the awaited VFS round trip inside the measured window', async () => {
    // The shape from #2718: `time ls <slow dir> | wc -l` in the terminal.
    const result = await shell.executeCommand('time ls /slow | wc -l');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('1\n');
    expect(realSeconds(result.stderr)).toBeGreaterThanOrEqual(0.05);
    expect(result.stderr).not.toMatch(/user|sys/);
  });
});

describe('just-bash time patch — installed dist', () => {
  // just-bash ships the interpreter three ways: the ESM bundle (Node/Vitest),
  // the self-contained browser bundle (what Vite bundles into the webapp — the
  // copy that runs in the leader tab and the kernel worker), and the CJS
  // bundle. The `time` COMMAND (`/usr/bin/time`-style, used when `time` is not
  // in keyword position) lives in its own chunk. A patch that misses one of
  // them passes every Node test and still lies in the terminal.
  it.each([
    'dist/bundle/browser.js',
    'dist/bundle/index.js',
    'dist/bundle/index.cjs',
    'dist/bundle/chunks/chunk-R2FBRMDU.js',
  ])('%s reports real without fabricated user/sys', async (rel) => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(
      new URL(`../../../../node_modules/just-bash/${rel}`, import.meta.url),
      'utf8'
    );
    const missing = `${rel} still emits fabricated user/sys; patches/just-bash+*.patch is missing or failed to apply`;
    expect(src.includes('\nuser\t0m0.000s\n'), missing).toBe(false);
    expect(src.includes('\nuser 0.00\nsys 0.00\n'), missing).toBe(false);
    expect(src.includes('real '), `${rel} lost its real line`).toBe(true);
  });
});
