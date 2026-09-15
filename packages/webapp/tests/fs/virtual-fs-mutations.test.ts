import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalMountBackend } from '../../src/fs/mount/backend-local.js';
import { RestrictedFS } from '../../src/fs/restricted-fs.js';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { createDirectoryHandle } from './fsa-test-helpers.js';

let dbCounter = 0;
let fs: VirtualFS;
let peer: VirtualFS;

beforeEach(async () => {
  const dbName = `mutation-contract-${dbCounter++}`;
  fs = await VirtualFS.create({ dbName, wipe: true });
  peer = await VirtualFS.create({ dbName });
});
afterEach(async () => {
  await peer.dispose();
  await fs.dispose();
});

describe('VFS mutation contracts', () => {
  it('preserves concurrent appends from instances sharing a database', async () => {
    await fs.writeFile('/file', 'start\n');
    await Promise.all(
      Array.from({ length: 40 }, (_, i) => (i % 2 ? fs : peer).appendFile('/file', `${i}\n`))
    );
    const lines = (await fs.readTextFile('/file')).trim().split('\n');
    expect(lines[0]).toBe('start');
    expect(
      lines
        .slice(1)
        .map(Number)
        .sort((a, b) => a - b)
    ).toEqual(Array.from({ length: 40 }, (_, i) => i));
  });

  it('creates missing parents, follows links, and preserves binary view boundaries', async () => {
    await fs.appendFile('/dir/file', 'ö');
    await fs.symlink('/dir/file', '/link');
    await peer.appendFile('/link', new Uint8Array([1, 255, 128, 2]).subarray(1, 3));
    expect(
      Array.from((await fs.readFile('/dir/file', { encoding: 'binary' })) as Uint8Array)
    ).toEqual([195, 182, 255, 128]);
    expect((await fs.lstat('/link')).type).toBe('symlink');
  });

  it('rejects directory appends and releases the lock after failure', async () => {
    await fs.mkdir('/dir');
    await expect(fs.appendFile('/dir', 'bad')).rejects.toMatchObject({ code: 'EISDIR' });
    await fs.appendFile('/after', 'ok');
    expect(await fs.readTextFile('/after')).toBe('ok');
    expect((await fs.stat('/dir')).type).toBe('directory');
  });

  it('updates metadata through a symlink and rejects missing or invalid targets', async () => {
    await fs.writeFile('/file', 'data');
    await fs.symlink('/file', '/link');
    await fs.chmod('/link', 0o755);
    await fs.utimes('/link', new Date(0), new Date(123456));
    expect((await fs.stat('/file')).mode! & 0o777).toBe(0o755);
    expect((await peer.stat('/file')).mtime).toBe(123456);
    await expect(fs.chmod('/missing', 0o755)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.utimes('/missing', new Date(0), new Date(0))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(fs.chmod('/file', -1)).rejects.toMatchObject({ code: 'EINVAL' });
    await expect(fs.utimes('/file', new Date(Number.NaN), new Date(0))).rejects.toMatchObject({
      code: 'EINVAL',
    });
  });

  it('serializes mounted appends and reports unsupported mounted metadata changes', async () => {
    const backend = LocalMountBackend.fromHandle(createDirectoryHandle({ file: 'A' }), {
      mountId: `mutations-${dbCounter}`,
    });
    await fs.mount('/mnt', backend);
    await Promise.all([fs.appendFile('/mnt/file', 'B'), fs.appendFile('/mnt/file', 'C')]);
    expect(await fs.readTextFile('/mnt/file')).toBe('ABC');
    await expect(fs.appendFile('/mnt', 'bad')).rejects.toMatchObject({ code: 'EISDIR' });
    await expect(fs.chmod('/mnt/file', 0o755)).rejects.toMatchObject({ code: 'ENOSYS' });
    await expect(fs.utimes('/mnt/file', new Date(0), new Date(0))).rejects.toMatchObject({
      code: 'ENOSYS',
    });
    await expect(fs.chmod('/mnt/missing', 0o755)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps appended process-substitution data private and rejects sandbox escapes', async () => {
    await fs.mkdir('/scoops/a', { recursive: true });
    await fs.writeFile('/secret', 'private');
    await fs.symlink('/secret', '/scoops/a/link');
    const restricted = new RestrictedFS(fs, ['/scoops/a/']);
    await Promise.all([
      restricted.appendFile('/dev/fd/63', 'A'),
      restricted.appendFile('/dev/fd/63', 'B'),
    ]);
    expect(await restricted.readTextFile('/dev/fd/63')).toBe('AB');
    expect(await fs.exists('/dev/fd/63')).toBe(false);
    for (const path of ['/secret', '/scoops/a/link']) {
      await expect(restricted.appendFile(path, 'bad')).rejects.toMatchObject({ code: 'EACCES' });
      await expect(restricted.chmod(path, 0o777)).rejects.toMatchObject({ code: 'EACCES' });
      await expect(restricted.utimes(path, new Date(0), new Date(0))).rejects.toMatchObject({
        code: 'EACCES',
      });
    }
    await expect(restricted.chmod('/dev/fd/63', 0o777)).rejects.toMatchObject({ code: 'EACCES' });
    await restricted.appendFile('/dev/null', 'discard');
    expect(await fs.readTextFile('/secret')).toBe('private');
  });
});
