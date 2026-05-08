import { describe, it, expect } from 'vitest';
import { LocalMountBackend } from '../../../src/fs/mount/backend-local.js';
import { createDirectoryHandle, createMutableDirectoryHandle } from '../fsa-test-helpers.js';

describe('LocalMountBackend basic ops', () => {
  it('readDir returns entries from the underlying handle', async () => {
    const handle = createDirectoryHandle({
      'a.txt': 'hello',
      sub: { 'b.txt': 'world' },
    });
    const backend = LocalMountBackend.fromHandle(handle, { mountId: 'm1' });

    const root = await backend.readDir('/');
    const names = root.map((e) => e.name).sort();
    expect(names).toEqual(['a.txt', 'sub']);
    expect(root.find((e) => e.name === 'a.txt')!.kind).toBe('file');
    expect(root.find((e) => e.name === 'sub')!.kind).toBe('directory');
  });

  it('readDir reports file size and lastModified', async () => {
    const handle = createDirectoryHandle({ 'a.txt': 'hello' });
    const backend = LocalMountBackend.fromHandle(handle, { mountId: 'm1' });
    const root = await backend.readDir('/');
    const file = root.find((e) => e.name === 'a.txt')!;
    expect(file.size).toBe(5);
    expect(typeof file.lastModified).toBe('number');
  });

  it('readFile returns the file body', async () => {
    const handle = createDirectoryHandle({ 'a.txt': 'hi' });
    const backend = LocalMountBackend.fromHandle(handle, { mountId: 'm1' });
    const got = await backend.readFile('a.txt');
    expect(new TextDecoder().decode(got)).toBe('hi');
  });

  it('readFile throws ENOENT for missing file', async () => {
    const handle = createDirectoryHandle({});
    const backend = LocalMountBackend.fromHandle(handle, { mountId: 'm1' });
    await expect(backend.readFile('nope.txt')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('writeFile round-trips a body', async () => {
    const mut = createMutableDirectoryHandle({});
    const backend = LocalMountBackend.fromHandle(mut.handle, { mountId: 'm1' });
    await backend.writeFile('foo.txt', new TextEncoder().encode('hi'));
    const got = await backend.readFile('foo.txt');
    expect(new TextDecoder().decode(got)).toBe('hi');
  });

  it('stat: file returns size and mtime', async () => {
    const handle = createDirectoryHandle({ 'a.txt': 'hello' });
    const backend = LocalMountBackend.fromHandle(handle, { mountId: 'm1' });
    const stat = await backend.stat('a.txt');
    expect(stat.kind).toBe('file');
    expect(stat.size).toBe(5);
    expect(typeof stat.mtime).toBe('number');
  });

  it('stat: directory reports kind=directory', async () => {
    const handle = createDirectoryHandle({ sub: {} });
    const backend = LocalMountBackend.fromHandle(handle, { mountId: 'm1' });
    const stat = await backend.stat('sub');
    expect(stat.kind).toBe('directory');
  });

  it('stat: missing path throws ENOENT', async () => {
    const handle = createDirectoryHandle({});
    const backend = LocalMountBackend.fromHandle(handle, { mountId: 'm1' });
    await expect(backend.stat('nope')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('mkdir creates a new directory', async () => {
    const mut = createMutableDirectoryHandle({});
    const backend = LocalMountBackend.fromHandle(mut.handle, { mountId: 'm1' });
    await backend.mkdir('new');
    const root = await backend.readDir('/');
    expect(root.find((e) => e.name === 'new')!.kind).toBe('directory');
  });

  it('remove deletes an entry', async () => {
    const mut = createMutableDirectoryHandle({ 'a.txt': 'x' });
    const backend = LocalMountBackend.fromHandle(mut.handle, { mountId: 'm1' });
    await backend.remove('a.txt');
    await expect(backend.readFile('a.txt')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refresh is a no-op returning empty RefreshReport', async () => {
    const handle = createDirectoryHandle({});
    const backend = LocalMountBackend.fromHandle(handle, { mountId: 'm1' });
    const report = await backend.refresh();
    expect(report).toEqual({
      added: [],
      removed: [],
      changed: [],
      unchanged: 0,
      errors: [],
    });
  });

  it('describe returns the handle name as displayName', async () => {
    const handle = createDirectoryHandle({}, 'my-dir');
    const backend = LocalMountBackend.fromHandle(handle, { mountId: 'm1' });
    expect(backend.describe()).toEqual({ displayName: 'my-dir' });
  });
});

describe('LocalMountBackend close lifecycle', () => {
  it('throws EBADF after close', async () => {
    const handle = createDirectoryHandle({ 'a.txt': 'hi' });
    const backend = LocalMountBackend.fromHandle(handle, { mountId: 'm1' });
    await backend.close();
    await expect(backend.readFile('a.txt')).rejects.toMatchObject({ code: 'EBADF' });
    await expect(backend.writeFile('b.txt', new Uint8Array())).rejects.toMatchObject({
      code: 'EBADF',
    });
    await expect(backend.readDir('/')).rejects.toMatchObject({ code: 'EBADF' });
    await expect(backend.stat('a.txt')).rejects.toMatchObject({ code: 'EBADF' });
    await expect(backend.refresh()).rejects.toMatchObject({ code: 'EBADF' });
  });

  it('close is idempotent', async () => {
    const handle = createDirectoryHandle({});
    const backend = LocalMountBackend.fromHandle(handle, { mountId: 'm1' });
    await backend.close();
    await backend.close();
    // No throw.
  });
});
