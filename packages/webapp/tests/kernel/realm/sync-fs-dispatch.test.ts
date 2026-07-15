import type { CommandContext } from 'just-bash';
import 'fake-indexeddb/auto';
import { expect, test } from 'vitest';
import { RestrictedFS } from '../../../src/fs/restricted-fs.js';
import { VirtualFS } from '../../../src/fs/virtual-fs.js';
import { dispatchSyncFs } from '../../../src/kernel/realm/sync-fs-dispatch.js';
import { mintSyncFsToken } from '../../../src/kernel/realm/sync-fs-token-registry.js';
import { VfsAdapter } from '../../../src/shell/vfs-adapter.js';

let counter = 0;

/**
 * Mint a token whose fs is the SAME shape a scoop realm gets: a `VfsAdapter`
 * (provides resolvePath/readFileBuffer/readdir) over a `RestrictedFS` scoped
 * to `scope` — so out-of-sandbox access is denied exactly as production.
 */
async function scopedToken(scope: string): Promise<string> {
  const vfs = await VirtualFS.create({ dbName: `sfd-${counter++}`, wipe: true });
  await vfs.mkdir('/scoops/x', { recursive: true });
  await vfs.writeFile('/scoops/x/in.txt', 'hi');
  await vfs.writeFile('/secret.txt', 'nope');
  const restricted = new RestrictedFS(vfs, [scope]);
  const fs = new VfsAdapter(restricted as unknown as VirtualFS) as unknown as CommandContext['fs'];
  return mintSyncFsToken({ fs, cwd: scope });
}

test('read returns bytes for an in-scope relative path', async () => {
  const token = await scopedToken('/scoops/x/');
  const r = await dispatchSyncFs({ token, op: 'read', path: 'in.txt' });
  expect(r.ok).toBe(true);
  if (r.ok && r.kind === 'bytes') expect(new TextDecoder().decode(r.bytes)).toBe('hi');
});

test('ESCALATION GUARD: out-of-sandbox absolute read is denied', async () => {
  const token = await scopedToken('/scoops/x/');
  const r = await dispatchSyncFs({ token, op: 'read', path: '/secret.txt' });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.errno).toMatch(/EACCES|ENOENT/);
});

test('ESCALATION GUARD: parent traversal out of sandbox is denied', async () => {
  const token = await scopedToken('/scoops/x/');
  const r = await dispatchSyncFs({ token, op: 'read', path: '../../secret.txt' });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.errno).toMatch(/EACCES|ENOENT/);
});

test('ESCALATION GUARD: out-of-sandbox write is denied', async () => {
  const token = await scopedToken('/scoops/x/');
  const r = await dispatchSyncFs({
    token,
    op: 'write',
    path: '/secret.txt',
    body: new TextEncoder().encode('pwned'),
  });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.errno).toMatch(/EACCES|ENOENT/);
});

test('read-after-write is coherent through one token', async () => {
  const token = await scopedToken('/scoops/x/');
  const w = await dispatchSyncFs({
    token,
    op: 'write',
    path: 'out.txt',
    body: new TextEncoder().encode('X'),
  });
  expect(w.ok).toBe(true);
  const r = await dispatchSyncFs({ token, op: 'read', path: 'out.txt' });
  expect(r.ok).toBe(true);
  if (r.ok && r.kind === 'bytes') expect(new TextDecoder().decode(r.bytes)).toBe('X');
});

test('read of a missing in-scope file → ENOENT', async () => {
  const token = await scopedToken('/scoops/x/');
  const r = await dispatchSyncFs({ token, op: 'read', path: 'nope.txt' });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.errno).toBe('ENOENT');
});

test('unknown / revoked token → EACCES (fail closed)', async () => {
  const r = await dispatchSyncFs({ token: 'bogus', op: 'read', path: 'x' });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.errno).toBe('EACCES');
});

test('exists / stat / readdir reflect the sandbox contents', async () => {
  const token = await scopedToken('/scoops/x/');
  const e = await dispatchSyncFs({ token, op: 'exists', path: 'in.txt' });
  expect(e.ok && e.kind === 'json' && e.json).toBe(true);
  const s = await dispatchSyncFs({ token, op: 'stat', path: 'in.txt' });
  expect(s.ok).toBe(true);
  if (s.ok && s.kind === 'json') expect((s.json as { isFile: boolean }).isFile).toBe(true);
  const d = await dispatchSyncFs({ token, op: 'readdir', path: '.' });
  expect(d.ok).toBe(true);
  if (d.ok && d.kind === 'json') expect(d.json).toContain('in.txt');
});
