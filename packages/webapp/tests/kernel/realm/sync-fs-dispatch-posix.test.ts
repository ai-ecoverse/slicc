/**
 * Single-node POSIX ops on the sync-fs dispatch (the Pyodide live-VFS
 * plugin's surface), run through the same scoped `VfsAdapter` over
 * `RestrictedFS` a scoop realm gets.
 */
import type { CommandContext } from 'just-bash';
import 'fake-indexeddb/auto';
import { expect, test } from 'vitest';
import { RestrictedFS } from '../../../src/fs/restricted-fs.js';
import { VirtualFS } from '../../../src/fs/virtual-fs.js';
import { dispatchSyncFs } from '../../../src/kernel/realm/sync-fs-dispatch.js';
import { mintSyncFsToken } from '../../../src/kernel/realm/sync-fs-token-registry.js';
import { VfsAdapter } from '../../../src/shell/vfs-adapter.js';

let counter = 0;

async function scopedToken(scope: string): Promise<string> {
  const vfs = await VirtualFS.create({ dbName: `sfdp-${counter++}`, wipe: true });
  await vfs.mkdir('/scoops/x', { recursive: true });
  await vfs.writeFile('/scoops/x/in.txt', 'hi');
  await vfs.writeFile('/secret.txt', 'nope');
  const restricted = new RestrictedFS(vfs, [scope]);
  const fs = new VfsAdapter(restricted as unknown as VirtualFS) as unknown as CommandContext['fs'];
  return mintSyncFsToken({ fs, cwd: scope });
}

type PosixReq = Omit<Parameters<typeof dispatchSyncFs>[0], 'token'>;
const posix = (token: string, req: PosixReq) => dispatchSyncFs({ token, ...req });
const errnoOf = (r: Awaited<ReturnType<typeof dispatchSyncFs>>): string => (r.ok ? '' : r.errno);

test('stat carries mode and mtimeMs', async () => {
  const token = await scopedToken('/scoops/x/');
  const r = await posix(token, { op: 'stat', path: 'in.txt' });
  expect(r.ok && r.kind).toBe('json');
  if (r.ok && r.kind === 'json') {
    const s = r.json as { mode: number; mtimeMs: number; size: number };
    expect(typeof s.mode).toBe('number');
    expect(s.mtimeMs).toBeGreaterThan(0);
    expect(s.size).toBe(2);
  }
});

test('unlink removes a file and refuses a directory', async () => {
  const token = await scopedToken('/scoops/x/');
  expect((await posix(token, { op: 'mkdir', path: 'd' })).ok).toBe(true);
  expect(errnoOf(await posix(token, { op: 'unlink', path: 'd' }))).toBe('EISDIR');
  expect((await posix(token, { op: 'unlink', path: 'in.txt' })).ok).toBe(true);
  const gone = await posix(token, { op: 'exists', path: 'in.txt' });
  expect(gone.ok && gone.kind === 'json' && gone.json).toBe(false);
});

test('rmdir removes only an empty directory', async () => {
  const token = await scopedToken('/scoops/x/');
  await posix(token, { op: 'mkdir', path: 'd' });
  await posix(token, { op: 'write', path: 'd/f', body: new Uint8Array([1]) });
  expect(errnoOf(await posix(token, { op: 'rmdir', path: 'd' }))).toBe('ENOTEMPTY');
  expect(errnoOf(await posix(token, { op: 'rmdir', path: 'in.txt' }))).toBe('ENOTDIR');
  await posix(token, { op: 'unlink', path: 'd/f' });
  expect((await posix(token, { op: 'rmdir', path: 'd' })).ok).toBe(true);
});

test('rename moves within scope; an out-of-scope destination is denied', async () => {
  const token = await scopedToken('/scoops/x/');
  expect((await posix(token, { op: 'rename', path: 'in.txt', arg2: 'out.txt' })).ok).toBe(true);
  const r = await posix(token, { op: 'read', path: 'out.txt' });
  expect(r.ok && r.kind === 'bytes' && new TextDecoder().decode(r.bytes)).toBe('hi');
  const escape = await posix(token, { op: 'rename', path: 'out.txt', arg2: '/secret.txt' });
  expect(escape.ok).toBe(false);
});

test('symlink + readlink round-trip the link', async () => {
  const token = await scopedToken('/scoops/x/');
  expect((await posix(token, { op: 'symlink', path: 'ln', arg2: 'in.txt' })).ok).toBe(true);
  const r = await posix(token, { op: 'readlink', path: 'ln' });
  expect(r.ok && r.kind === 'json' && r.json).toMatch(/in\.txt$/);
  const l = await posix(token, { op: 'lstat', path: 'ln' });
  expect(l.ok && l.kind === 'json' && (l.json as { isSymbolicLink: boolean }).isSymbolicLink).toBe(
    true
  );
});

test('an out-of-scope symlink path is denied', async () => {
  const token = await scopedToken('/scoops/x/');
  const r = await posix(token, { op: 'symlink', path: '/evil', arg2: '/scoops/x/in.txt' });
  expect(r.ok).toBe(false);
});

test('chmod and utimes land in the next stat', async () => {
  const token = await scopedToken('/scoops/x/');
  expect((await posix(token, { op: 'chmod', path: 'in.txt', mode: 0o755 })).ok).toBe(true);
  const times = { op: 'utimes', path: 'in.txt', atimeMs: 1_000, mtimeMs: 2_000_000 } as const;
  expect((await posix(token, times)).ok).toBe(true);
  const r = await posix(token, { op: 'stat', path: 'in.txt' });
  expect(r.ok && r.kind === 'json').toBe(true);
  if (r.ok && r.kind === 'json') {
    const s = r.json as { mode: number; mtimeMs: number };
    expect(s.mode & 0o777).toBe(0o755);
    expect(s.mtimeMs).toBe(2_000_000);
  }
});

test('POSIX ops missing their arguments fail EINVAL', async () => {
  const token = await scopedToken('/scoops/x/');
  for (const op of ['chmod', 'utimes', 'symlink'] as const) {
    expect(errnoOf(await posix(token, { op, path: 'in.txt' }))).toBe('EINVAL');
  }
});
