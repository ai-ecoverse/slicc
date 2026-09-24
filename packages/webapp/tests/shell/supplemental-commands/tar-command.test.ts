import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VirtualFS } from '../../../src/fs/index.js';
import { AlmostBashShellHeadless } from '../../../src/shell/almost-bash-shell-headless.js';
import { writeTar } from '../../../src/shell/ipk/tar.js';

describe('tar command', () => {
  let fs: VirtualFS;
  let shell: AlmostBashShellHeadless;
  let dbCounter = 0;

  beforeEach(async () => {
    fs = await VirtualFS.create({
      dbName: `test-tar-command-${dbCounter++}`,
      wipe: true,
    });
    shell = new AlmostBashShellHeadless({ fs });
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

  it('keeps executable bits across create and extract (./configure stays runnable)', async () => {
    await fs.writeFile('/workspace/source/configure', '#!/bin/sh\necho configured\n');
    expect((await shell.executeCommand('chmod 755 /workspace/source/configure')).exitCode).toBe(0);
    await shell.executeCommand('cd /workspace && tar -czf /tmp/exec.tgz source');
    const out = await shell.executeCommand('tar -xzf /tmp/exec.tgz -C /tmp/exec-out');
    expect(out.exitCode).toBe(0);
    expect(((await fs.stat('/tmp/exec-out/source/configure')).mode ?? 0) & 0o777).toBe(0o755);
    expect(((await fs.stat('/tmp/exec-out/source/hello.txt')).mode ?? 0) & 0o777).toBe(0o644);
  });

  it("applies an archive's own modes on extract", async () => {
    await fs.writeFile(
      '/tmp/modes.tar',
      writeTar([
        { path: 'pkg/run.sh', bytes: new TextEncoder().encode('echo hi'), mode: 0o755 },
        { path: 'pkg/secret', bytes: new TextEncoder().encode('s'), mode: 0o600 },
      ])
    );
    expect((await shell.executeCommand('tar -xf /tmp/modes.tar -C /tmp/modes')).exitCode).toBe(0);
    expect(((await fs.stat('/tmp/modes/pkg/run.sh')).mode ?? 0) & 0o777).toBe(0o755);
    expect(((await fs.stat('/tmp/modes/pkg/secret')).mode ?? 0) & 0o777).toBe(0o600);
  });

  it('finishes extracting where the backend has no mode bits (a mount: ENOSYS)', async () => {
    await fs.writeFile(
      '/tmp/mounted.tar',
      writeTar([
        { path: 'pkg/configure', bytes: new TextEncoder().encode('#!/bin/sh'), mode: 0o755 },
        { path: 'pkg/after.txt', bytes: new TextEncoder().encode('after') },
      ])
    );
    vi.spyOn(fs, 'chmod').mockRejectedValue(
      Object.assign(new Error('metadata changes are not supported by this mount'), {
        code: 'ENOSYS',
      })
    );
    const out = await shell.executeCommand('tar -xf /tmp/mounted.tar -C /tmp/mounted');
    expect(out.exitCode).toBe(0);
    expect(await fs.readFile('/tmp/mounted/pkg/after.txt')).toBe('after');
  });

  it('resets an existing executable to the archived 0644', async () => {
    await fs.mkdir('/tmp/over/pkg', { recursive: true });
    await fs.writeFile('/tmp/over/pkg/tool', 'old');
    await shell.executeCommand('chmod 755 /tmp/over/pkg/tool');
    await fs.writeFile(
      '/tmp/over.tar',
      writeTar([{ path: 'pkg/tool', bytes: new TextEncoder().encode('new'), mode: 0o644 }])
    );
    expect((await shell.executeCommand('tar -xf /tmp/over.tar -C /tmp/over')).exitCode).toBe(0);
    expect(((await fs.stat('/tmp/over/pkg/tool')).mode ?? 0) & 0o777).toBe(0o644);
  });

  it('keeps directory modes, applied after the tree is filled', async () => {
    await fs.mkdir('/workspace/dirs/private/ro', { recursive: true });
    await fs.writeFile('/workspace/dirs/private/ro/file.txt', 'inside');
    await shell.executeCommand(
      'chmod 700 /workspace/dirs/private && chmod 555 /workspace/dirs/private/ro'
    );
    await shell.executeCommand('cd /workspace && tar -cf /tmp/dirs.tar dirs');
    const out = await shell.executeCommand('tar -xf /tmp/dirs.tar -C /tmp/dirs-out');
    expect(out.exitCode).toBe(0);
    expect(await fs.readFile('/tmp/dirs-out/dirs/private/ro/file.txt')).toBe('inside');
    expect(((await fs.stat('/tmp/dirs-out/dirs/private')).mode ?? 0) & 0o777).toBe(0o700);
    expect(((await fs.stat('/tmp/dirs-out/dirs/private/ro')).mode ?? 0) & 0o777).toBe(0o555);
  });

  it("restores archived mtimes (automake's Makefiles compare them)", async () => {
    await fs.writeFile(
      '/tmp/times.tar',
      writeTar([
        { path: 'pkg/', bytes: new Uint8Array(0), directory: true, mtime: 1600000000 },
        { path: 'pkg/configure.ac', bytes: new TextEncoder().encode('ac'), mtime: 1600000000 },
        { path: 'pkg/Makefile.in', bytes: new TextEncoder().encode('in'), mtime: 1700000000 },
      ])
    );
    expect((await shell.executeCommand('tar -xf /tmp/times.tar -C /tmp/times')).exitCode).toBe(0);

    const secs = async (p: string) => Math.floor(Number((await fs.stat(p)).mtime) / 1000);
    expect(await secs('/tmp/times/pkg/configure.ac')).toBe(1600000000);
    expect(await secs('/tmp/times/pkg/Makefile.in')).toBe(1700000000);
    expect(await secs('/tmp/times/pkg')).toBe(1600000000);
  });

  it("gives a path archived twice the last member's content, mode and mtime", async () => {
    const bytes = (s: string) => new TextEncoder().encode(s);
    await fs.writeFile(
      '/tmp/dup.tar',
      writeTar([
        { path: 'pkg/', bytes: new Uint8Array(0), directory: true, mode: 0o700, mtime: 1500000000 },
        { path: 'pkg/f', bytes: bytes('old'), mode: 0o600, mtime: 1600000000 },
        { path: 'pkg/f', bytes: bytes('new'), mode: 0o644, mtime: 1700000000 },
        { path: 'pkg/', bytes: new Uint8Array(0), directory: true, mode: 0o755, mtime: 1650000000 },
      ])
    );
    expect((await shell.executeCommand('tar -xf /tmp/dup.tar -C /tmp/dup')).exitCode).toBe(0);
    const secs = async (p: string) => Math.floor(Number((await fs.stat(p)).mtime) / 1000);
    expect(await fs.readFile('/tmp/dup/pkg/f')).toBe('new');
    expect(await secs('/tmp/dup/pkg/f')).toBe(1700000000);
    expect(((await fs.stat('/tmp/dup/pkg/f')).mode ?? 0) & 0o777).toBe(0o644);
    expect(await secs('/tmp/dup/pkg')).toBe(1650000000);
    expect(((await fs.stat('/tmp/dup/pkg')).mode ?? 0) & 0o777).toBe(0o755);
  });

  it('records mtimes on create', async () => {
    await shell.executeCommand('touch -d "2021-06-01 00:00:00" /workspace/source/hello.txt');
    await shell.executeCommand('cd /workspace && tar -cf /tmp/rec.tar source');
    const out = await shell.executeCommand('mkdir -p /tmp/rec && tar -xf /tmp/rec.tar -C /tmp/rec');
    expect(out.exitCode).toBe(0);
    const before = Number((await fs.stat('/workspace/source/hello.txt')).mtime);
    const after = Number((await fs.stat('/tmp/rec/source/hello.txt')).mtime);

    expect(Date.now() - before).toBeGreaterThan(365 * 24 * 3600 * 1000);
    expect(Math.floor(after / 1000)).toBe(Math.floor(before / 1000));
  });

  it('accepts the traditional dashless form (tar xzf, tar czf)', async () => {
    const created = await shell.executeCommand('cd /workspace && tar czf /tmp/trad.tgz source');
    expect(created.exitCode).toBe(0);
    const extracted = await shell.executeCommand(
      'cd /tmp && mkdir trad && cd trad && tar xzf /tmp/trad.tgz'
    );
    expect(extracted.exitCode).toBe(0);
    expect(await fs.readFile('/tmp/trad/source/hello.txt')).toBe('hello tar');
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
