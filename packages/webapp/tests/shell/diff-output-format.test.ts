import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../src/fs/index.js';
import { AlmostBashShellHeadless } from '../../src/shell/almost-bash-shell-headless.js';

describe('diff output format (#2950)', () => {
  let fs: VirtualFS;
  let shell: AlmostBashShellHeadless;
  let dbCounter = 0;

  beforeEach(async () => {
    fs = await VirtualFS.create({ dbName: `test-diff-format-${dbCounter++}`, wipe: true });
    await fs.mkdir('/work', { recursive: true });
    await fs.writeFile('/work/a', 'a\nb\nc\n');
    await fs.writeFile('/work/b', 'a\nX\nc\n');
    shell = new AlmostBashShellHeadless({ fs, cwd: '/work' });
  });

  afterEach(() => {
    shell.dispose();
  });

  it('defaults to normal format', async () => {
    const r = await shell.executeCommand('diff a b');
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe('2c2\n< b\n---\n> X\n');
  });

  it('lets grep count the changed lines', async () => {
    const r = await shell.executeCommand("diff a b | grep -cE '^[<>]'");
    expect(r.stdout).toBe('2\n');
    const onlyInA = await shell.executeCommand("diff a b | grep '^<'");
    expect(onlyInA.stdout).toBe('< b\n');
  });

  it('prints unified format for -u without a banner', async () => {
    const r = await shell.executeCommand('diff -u a b');
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe('--- a\n+++ b\n@@ -1,3 +1,3 @@\n a\n-b\n+X\n c\n');
    expect(r.stdout).not.toContain('===');
  });

  it('keeps -q and the exit codes', async () => {
    const differ = await shell.executeCommand('diff -q a b');
    expect(differ.exitCode).toBe(1);
    expect(differ.stdout).toBe('Files a and b differ\n');
    const same = await shell.executeCommand('diff a a');
    expect(same.exitCode).toBe(0);
    expect(same.stdout).toBe('');
  });

  it('resolves to the just-bash command, not a SLICC override', async () => {
    const r = await shell.executeCommand('/usr/bin/diff a b');
    expect(r.stdout).toBe('2c2\n< b\n---\n> X\n');
  });
});
