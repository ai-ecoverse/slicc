import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../../src/fs/index.js';
import { AlmostBashShell } from '../../../src/shell/almost-bash-shell.js';
import { writeTar } from '../../../src/shell/ipk/tar.js';

describe('tar command', () => {
  let fs: VirtualFS;
  let shell: AlmostBashShell;
  let dbCounter = 0;

  beforeEach(async () => {
    fs = await VirtualFS.create({
      dbName: `test-tar-command-${dbCounter++}`,
      wipe: true,
    });
    shell = new AlmostBashShell({ fs });
    await fs.mkdir('/workspace/source/nested', { recursive: true });
    await fs.mkdir('/workspace/source/empty', { recursive: true });
    await fs.writeFile('/workspace/source/hello.txt', 'hello tar');
    await fs.writeFile('/workspace/source/nested/data.bin', new Uint8Array([0, 1, 2, 255]));
  });

  afterEach(async () => {
    await fs.dispose();
  });

  it('creates, lists, and extracts a plain archive with separate flags', async () => {
    const created = await shell.executeCommand('cd /workspace && tar -c -f /tmp/plain.tar source');
    expect(created.exitCode).toBe(0);

    const listed = await shell.executeCommand('tar -t -f /tmp/plain.tar');
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout.trim().split('\n').sort()).toEqual(
      [
        'source/empty/',
        'source/hello.txt',
        'source/nested/',
        'source/nested/data.bin',
        'source/',
      ].sort()
    );

    const extracted = await shell.executeCommand('tar -x -f /tmp/plain.tar -C /tmp/plain-out');
    expect(extracted.exitCode).toBe(0);
    expect(await fs.readFile('/tmp/plain-out/source/hello.txt')).toBe('hello tar');
    const binary = await fs.readFile('/tmp/plain-out/source/nested/data.bin', {
      encoding: 'binary',
    });
    expect(Array.from(binary as Uint8Array)).toEqual([0, 1, 2, 255]);
    expect(await fs.stat('/tmp/plain-out/source/empty')).toMatchObject({ type: 'directory' });
  });

  it('round-trips gzip archives, auto-detects gzip, and reports verbose paths', async () => {
    const created = await shell.executeCommand('cd /workspace && tar -czvf /tmp/source.tgz source');
    expect(created.exitCode).toBe(0);
    expect(created.stdout).toContain('source/nested/data.bin');

    const archive = await fs.readFile('/tmp/source.tgz', { encoding: 'binary' });
    expect(archive).toBeInstanceOf(Uint8Array);
    expect(Array.from((archive as Uint8Array).slice(0, 2))).toEqual([0x1f, 0x8b]);

    const listed = await shell.executeCommand('tar -tf /tmp/source.tgz');
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toContain('source/hello.txt');

    const extracted = await shell.executeCommand('tar -xvf /tmp/source.tgz -C /tmp/gzip-out');
    expect(extracted.exitCode).toBe(0);
    expect(extracted.stdout).toContain('source/hello.txt');
    expect(await fs.readFile('/tmp/gzip-out/source/hello.txt')).toBe('hello tar');
  });

  it('preserves a package/ entry prefix', async () => {
    await fs.mkdir('/workspace/package', { recursive: true });
    await fs.writeFile('/workspace/package/index.js', 'export {};');
    const created = await shell.executeCommand('cd /workspace && tar -cf /tmp/package.tar package');
    expect(created.exitCode).toBe(0);
    const listed = await shell.executeCommand('tar -tf /tmp/package.tar');
    expect(listed.stdout).toContain('package/index.js');
  });

  it('uses -C as the create input directory without moving the archive path', async () => {
    const created = await shell.executeCommand(
      'cd /workspace && tar -czf app.tgz -C /workspace/source .'
    );
    expect(created.exitCode).toBe(0);
    expect(await fs.exists('/workspace/app.tgz')).toBe(true);
    expect(await fs.exists('/workspace/source/app.tgz')).toBe(false);

    const listed = await shell.executeCommand('tar -tf /workspace/app.tgz');
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toContain('./hello.txt');
    expect(listed.stdout).toContain('./nested/data.bin');
    expect(listed.stdout).not.toContain('source/hello.txt');
  });

  it('rejects traversal and absolute archive entry paths', async () => {
    const traversal = writeTar([
      { path: '../escape.txt', bytes: new TextEncoder().encode('escape') },
    ]);
    await fs.writeFile('/tmp/traversal.tar', traversal);
    const traversalResult = await shell.executeCommand(
      'tar -xf /tmp/traversal.tar -C /workspace/out'
    );
    expect(traversalResult.exitCode).toBe(1);
    expect(traversalResult.stderr).toContain('blocked suspicious path ../escape.txt');
    expect(await fs.exists('/workspace/escape.txt')).toBe(false);

    const absolute = writeTar([{ path: '/escape.txt', bytes: new Uint8Array([1]) }]);
    await fs.writeFile('/tmp/absolute.tar', absolute);
    const absoluteResult = await shell.executeCommand(
      'tar -xf /tmp/absolute.tar -C /workspace/out'
    );
    expect(absoluteResult.exitCode).toBe(1);
    expect(absoluteResult.stderr).toContain('blocked suspicious path /escape.txt');
  });

  it('prints help and rejects unknown or incomplete options', async () => {
    for (const command of ['tar', 'tar -h', 'tar --help']) {
      const result = await shell.executeCommand(command);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('usage: tar');
    }

    const unknown = await shell.executeCommand('tar -qf /tmp/nope.tar');
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain('unsupported option -q');
    const missingArchive = await shell.executeCommand('tar -c /workspace/source');
    expect(missingArchive.exitCode).toBe(1);
    expect(missingArchive.stderr).toContain('-f requires an archive path');
  });

  it('is discoverable through which and commands', async () => {
    const which = await shell.executeCommand('which tar');
    expect(which.exitCode).toBe(0);
    expect(which.stdout).toBe('/usr/bin/tar\n');
    const commands = await shell.executeCommand('commands | grep tar');
    expect(commands.exitCode).toBe(0);
    expect(commands.stdout).toMatch(/\btar\b/);
  });
});
