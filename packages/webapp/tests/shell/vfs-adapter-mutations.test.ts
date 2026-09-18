import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { VfsAdapter } from '../../src/shell/vfs-adapter.js';

let counter = 0;
let left: VirtualFS;
let right: VirtualFS;
beforeEach(async () => {
  left = await VirtualFS.create({ dbName: `adapter-mutations-a-${counter}`, wipe: true });
  right = await VirtualFS.create({ dbName: `adapter-mutations-b-${counter++}`, wipe: true });
});
afterEach(async () => {
  await left.dispose();
  await right.dispose();
});

describe('shell filesystem mutations and identity', () => {
  it('preserves appends from separate adapters and exposes changed metadata', async () => {
    const a = new VfsAdapter(left);
    const b = new VfsAdapter(left);
    await a.writeFile('/file', 'A');
    await Promise.all([a.appendFile('/file', 'B'), b.appendFile('/file', 'C')]);
    expect(await a.readFile('/file')).toBe('ABC');
    await a.chmod('/file', 0o755);
    expect((await a.stat('/file')).mode & 0o777).toBe(0o755);
    expect((await b.lstat('/file')).mode & 0o777).toBe(0o755);
    await a.utimes('/file', new Date(0), new Date(123456));
    expect((await b.stat('/file')).mtime.getTime()).toBe(123456);
    await expect(a.chmod('/missing', 0o755)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(a.utimes('/missing', new Date(0), new Date(0))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('distinguishes equal inode numbers in different databases and preserves rename identity', async () => {
    await left.writeFile('/file', 'A');
    await right.writeFile('/file', 'B');
    const a = new VfsAdapter(left);
    const b = new VfsAdapter(right);
    const first = await a.stat('/file');
    const second = await b.stat('/file');
    expect(first.ino).toBe(second.ino);
    expect(first.identity).toBeDefined();
    expect(first.identity).not.toBe(second.identity);
    await a.mv('/file', '/renamed');
    expect((await a.stat('/renamed')).identity).toBe(first.identity);
    expect((await a.lstat('/renamed')).identity).toBe(first.identity);
  });
});
