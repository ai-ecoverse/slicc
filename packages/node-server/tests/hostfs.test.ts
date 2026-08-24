import express from 'express';
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { registerHostFsRoutes, resolveHostMountRoots, resolveWithinRoot } from '../src/hostfs.js';

let root: string;
let outside: string;
let baseUrl: string;
let close: () => Promise<void>;

async function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl}${path}`, init);
}

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'slicc-hostfs-')));
  outside = await realpath(await mkdtemp(join(tmpdir(), 'slicc-hostfs-outside-')));
  await mkdir(join(root, 'sub'));
  await writeFile(join(root, 'hello.txt'), 'hello host');
  await writeFile(join(outside, 'secret.txt'), 'nope');
  await symlink(outside, join(root, 'escape-link'));
  await symlink(join(root, 'sub'), join(root, 'inside-link'));

  const app = express();
  const roots = await resolveHostMountRoots(
    [
      { hostPath: root, path: '/mnt/proj' },
      { hostPath: join(root, 'does-not-exist'), path: '/mnt/gone' },
    ],
    () => {}
  );
  expect(roots).toEqual([{ path: '/mnt/proj', root }]);
  registerHostFsRoutes(app, roots);
  const listening = app.listen(0);
  const port = (listening.address() as { port: number }).port;
  baseUrl = `http://127.0.0.1:${port}`;
  close = () => new Promise((r) => listening.close(() => r()));
});

afterAll(async () => {
  await close();
});

describe('hostfs routes', () => {
  it('lists a directory with file sizes', async () => {
    const res = await api('/api/hostfs/list?mount=%2Fmnt%2Fproj&path=');
    expect(res.status).toBe(200);
    const { entries } = (await res.json()) as { entries: { name: string; kind: string }[] };
    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual(['escape-link', 'hello.txt', 'inside-link', 'sub']);
    const hello = entries.find((e) => e.name === 'hello.txt') as { size?: number };
    expect(hello.size).toBe(10);
  });

  it('stats and reads a file', async () => {
    const statRes = await api('/api/hostfs/stat?mount=%2Fmnt%2Fproj&path=hello.txt');
    expect(((await statRes.json()) as { kind: string }).kind).toBe('file');
    const readRes = await api('/api/hostfs/read?mount=%2Fmnt%2Fproj&path=hello.txt');
    expect(await readRes.text()).toBe('hello host');
  });

  it('writes a file, creating parents', async () => {
    const res = await api('/api/hostfs/write?mount=%2Fmnt%2Fproj&path=new/deep/file.txt', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: 'written from test',
    });
    expect(res.status).toBe(200);
    expect(await readFile(join(root, 'new/deep/file.txt'), 'utf8')).toBe('written from test');
  });

  it('mkdir, rename, and remove work and refuse the mount root', async () => {
    expect(
      (await api('/api/hostfs/mkdir?mount=%2Fmnt%2Fproj&path=made', { method: 'POST' })).status
    ).toBe(200);
    expect(
      (
        await api('/api/hostfs/rename?mount=%2Fmnt%2Fproj&path=made&to=renamed', {
          method: 'POST',
        })
      ).status
    ).toBe(200);
    expect(
      (
        await api('/api/hostfs/remove?mount=%2Fmnt%2Fproj&path=renamed&recursive=1', {
          method: 'DELETE',
        })
      ).status
    ).toBe(200);
    const rootRm = await api('/api/hostfs/remove?mount=%2Fmnt%2Fproj&path=&recursive=1', {
      method: 'DELETE',
    });
    expect(rootRm.status).toBe(403);
  });

  it('maps errno to status + FsError code', async () => {
    const missing = await api('/api/hostfs/read?mount=%2Fmnt%2Fproj&path=missing.txt');
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { code: string }).code).toBe('ENOENT');
    const dirRead = await api('/api/hostfs/read?mount=%2Fmnt%2Fproj&path=sub');
    expect(dirRead.status).toBe(409);
    expect(((await dirRead.json()) as { code: string }).code).toBe('EISDIR');
    const noMount = await api('/api/hostfs/list?mount=%2Fmnt%2Fnope&path=');
    expect(noMount.status).toBe(404);
  });

  it('rejects traversal and symlink escapes with EACCES', async () => {
    const dotdot = await api('/api/hostfs/read?mount=%2Fmnt%2Fproj&path=..%2Fsecret.txt');
    expect(dotdot.status).toBe(403);
    const viaLink = await api('/api/hostfs/read?mount=%2Fmnt%2Fproj&path=escape-link%2Fsecret.txt');
    expect(viaLink.status).toBe(403);
    // Symlinks that stay inside the root are followed.
    const inside = await api('/api/hostfs/list?mount=%2Fmnt%2Fproj&path=inside-link');
    expect(inside.status).toBe(200);
  });
});

describe('resolveWithinRoot', () => {
  it('resolves the root itself and nested paths', async () => {
    expect(await resolveWithinRoot(root, '')).toBe(root);
    expect(await resolveWithinRoot(root, 'a/b')).toBe(join(root, 'a/b'));
  });

  it('rejects lexical escapes even for non-existent paths', async () => {
    await expect(resolveWithinRoot(root, '../x')).rejects.toMatchObject({ code: 'EACCES' });
    await expect(resolveWithinRoot(root, 'a/../../x')).rejects.toMatchObject({ code: 'EACCES' });
  });

  it('rejects writes under an escaping symlinked ancestor', async () => {
    await expect(resolveWithinRoot(root, 'escape-link/new-file.txt')).rejects.toMatchObject({
      code: 'EACCES',
    });
  });
});
