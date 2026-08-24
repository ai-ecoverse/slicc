import 'fake-indexeddb/auto';
import { zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../../src/fs/index.js';
import { AlmostBashShellHeadless } from '../../../src/shell/almost-bash-shell-headless.js';

describe('unzip command', () => {
  let fs: VirtualFS;
  let shell: AlmostBashShellHeadless;
  let dbCounter = 0;

  beforeEach(async () => {
    fs = await VirtualFS.create({
      dbName: `test-unzip-command-${dbCounter++}`,
      wipe: true,
    });
    shell = new AlmostBashShellHeadless({ fs });
    await fs.mkdir('/workspace', { recursive: true });
  });

  afterEach(async () => {
    await fs.dispose();
  });

  async function writeZip(path: string, entries: Record<string, Uint8Array>): Promise<void> {
    await fs.writeFile(path, zipSync(entries));
  }

  it('prints help with no args or with -h/--help', async () => {
    for (const command of ['unzip', 'unzip -h', 'unzip --help']) {
      const result = await shell.executeCommand(command);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('usage: unzip');
    }
  });

  it('extracts files into the current directory by default', async () => {
    const enc = new TextEncoder();
    await writeZip('/workspace/archive.zip', {
      'hello.txt': enc.encode('hello unzip'),
      'nested/data.bin': new Uint8Array([0, 1, 2, 255]),
      'emptydir/': new Uint8Array(0),
    });

    const result = await shell.executeCommand('cd /workspace && unzip archive.zip');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('extracted 2 file(s)');
    expect(await fs.readFile('/workspace/hello.txt')).toBe('hello unzip');
    const binary = await fs.readFile('/workspace/nested/data.bin', { encoding: 'binary' });
    expect(Array.from(binary as Uint8Array)).toEqual([0, 1, 2, 255]);
    // Directory placeholder entries are skipped, not counted.
    expect(await fs.exists('/workspace/emptydir')).toBe(false);
  });

  it('extracts into an explicit -d destination', async () => {
    const enc = new TextEncoder();
    await writeZip('/workspace/archive.zip', { 'file.txt': enc.encode('data') });

    const result = await shell.executeCommand('cd /workspace && unzip archive.zip -d out');
    expect(result.exitCode).toBe(0);
    expect(await fs.readFile('/workspace/out/file.txt')).toBe('data');
  });

  it('rejects unsupported options', async () => {
    const result = await shell.executeCommand('unzip -q archive.zip');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unsupported option -q');
  });

  it('requires an archive path when only flags are given', async () => {
    const result = await shell.executeCommand('unzip -d out');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('expected archive path');
  });

  it('blocks entries that escape the destination root', async () => {
    const enc = new TextEncoder();
    await writeZip('/workspace/evil.zip', { '../escape.txt': enc.encode('escape') });

    const result = await shell.executeCommand('cd /workspace && unzip evil.zip -d out');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('blocked suspicious path ../escape.txt');
    expect(await fs.exists('/workspace/escape.txt')).toBe(false);
  });
});
