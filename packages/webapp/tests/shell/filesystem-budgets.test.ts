import 'fake-indexeddb/auto';
import { defineCommand } from 'just-bash';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { AlmostBashShellHeadless } from '../../src/shell/almost-bash-shell-headless.js';

let fs: VirtualFS;
let counter = 0;
const shells: AlmostBashShellHeadless[] = [];
beforeEach(async () => {
  fs = await VirtualFS.create({ dbName: `filesystem-budgets-${counter++}`, wipe: true });
});
afterEach(async () => {
  for (const shell of shells.splice(0)) shell.dispose();
  await fs.dispose();
});

function makeShell(
  options: Omit<ConstructorParameters<typeof AlmostBashShellHeadless>[0], 'fs'> = {}
) {
  const shell = new AlmostBashShellHeadless({ fs, ...options });
  shells.push(shell);
  return shell;
}

describe('shell filesystem budgets', () => {
  it('supplies bounded filesystem limits to scoop commands without shortening their execution time', async () => {
    const scoop = makeShell({ isScoop: () => true });
    const cone = makeShell();
    const limits = async (shell: AlmostBashShellHeadless) => {
      shell.getBash().registerCommand(
        defineCommand('echo', async (_args, ctx) => ({
          stdout: JSON.stringify(ctx.limits),
          stderr: '',
          exitCode: 0,
        }))
      );
      const result = await shell.executeCommand('echo');
      expect(result.exitCode).toBe(0);
      return JSON.parse(result.stdout);
    };
    const child = await limits(scoop);
    const parent = await limits(cone);
    expect(child).toMatchObject({
      maxInputBytes: 32 * 1024 * 1024,
      maxLiveBytes: 64 * 1024 * 1024,
      maxTraversalEntries: 100_000,
      maxTraversalDepth: 256,
      maxArchiveBytes: 128 * 1024 * 1024,
      maxArchiveEntryBytes: 64 * 1024 * 1024,
    });
    expect(child.maxExecutionTimeMs).toBe(parent.maxExecutionTimeMs);
    expect(parent.maxInputBytes).toBe(512 * 1024 * 1024);
  });

  it('enforces traversal limits with the supplied VirtualFS and permits trusted overrides', async () => {
    await fs.writeFile('/tree/a', 'a');
    await fs.writeFile('/tree/b', 'b');
    await fs.writeFile('/tree/c', 'c');
    const bounded = makeShell({ isScoop: () => true, executionLimits: { maxTraversalEntries: 2 } });
    const result = await bounded.executeCommand('find /tree');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('traversal entry limit');
    const raised = makeShell({ isScoop: () => true, executionLimits: { maxTraversalEntries: 20 } });
    expect((await raised.executeCommand('find /tree')).exitCode).toBe(0);
  });

  it('enforces input limits in upstream file readers', async () => {
    await fs.writeFile('/input', 'abcdef');
    const shell = makeShell({ isScoop: () => true, executionLimits: { maxInputBytes: 3 } });
    const result = await shell.executeCommand('cat /input');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/limit/i);
  });

  it('passes the selected preset through to the interpreter', async () => {
    const shell = makeShell({ executionLimitProfile: 'hardened' });
    const result = await shell.executeCommand('for ((i=0; i<10001; i++)); do :; done');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('executionLimits.maxCommandCount');
  });

  it('does not present maxFileSystemBytes as a quota on the supplied VFS', async () => {
    const shell = makeShell({ executionLimits: { maxFileSystemBytes: 1 } });
    expect((await shell.executeCommand('echo abcdef > /file')).exitCode).toBe(0);
    expect(await fs.readTextFile('/file')).toBe('abcdef\n');
  });
});
