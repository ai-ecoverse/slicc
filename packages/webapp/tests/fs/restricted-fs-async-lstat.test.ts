/**
 * Async `RestrictedFS.lstat()` symlink-escape parity (VAL-FS-019).
 *
 * Round-1 core-followup added the ancestor-symlink ACL to the three
 * SYNC fast-path methods (statSync / lstatSync / readDirSync). Round-2
 * scrutiny identified a residual gap: async `RestrictedFS.lstat()` only
 * performed a lexical `isAllowed(path)` check and then delegated to
 * `vfs.lstat(path)` — but LightningFS follows ancestor symlinks during
 * `lstat`, so a symlink inside an allowed prefix whose target escapes
 * the ACL could still leak sibling-scoop metadata (file type, size,
 * mtime) through the shell's async fallback path.
 *
 * These tests lock down the fix: the async `lstat()` MUST resolve the
 * parent directory (NOT the leaf — `lstat` must not follow the leaf
 * symlink) and reject if the resulting path is no longer within the
 * ACL.
 *
 * Shape mirrors the existing VAL-FS-019 parity block in
 * `restricted-fs-sync.test.ts`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import 'fake-indexeddb/auto';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { RestrictedFS } from '../../src/fs/restricted-fs.js';
import { WasmShell } from '../../src/shell/wasm-shell.js';

describe('RestrictedFS async lstat rejects ancestor-symlink escape (VAL-FS-019 parity)', () => {
  let vfs: VirtualFS;
  let restricted: RestrictedFS;
  const scoopFolder = '/scoops/agent-async-lstat/';
  const cwd = '/home/wiki/';

  beforeAll(async () => {
    vfs = await VirtualFS.create({
      dbName: 'test-restricted-fs-async-lstat',
      wipe: true,
    });
    await vfs.mkdir('/scoops/agent-async-lstat/workspace', { recursive: true });
    await vfs.mkdir('/shared', { recursive: true });
    await vfs.mkdir('/workspace', { recursive: true });
    await vfs.mkdir('/home/wiki', { recursive: true });
    await vfs.mkdir('/scoops/other-scoop', { recursive: true });

    await vfs.writeFile('/shared/real-file', 'shared real contents');
    await vfs.writeFile('/scoops/other-scoop/secret', 'SIBLING SCOOP SECRET');
    await vfs.writeFile('/scoops/other-scoop/another-secret', 'another leak');
    await vfs.writeFile('/outside-file', 'outside data');

    // Escape symlink: INSIDE an allowed prefix, target escapes every
    // allowed prefix.
    await vfs.symlink('/scoops/other-scoop', '/shared/escape-link');
    // Legit symlink: inside allowed prefix, target also inside allowed
    // prefix. `lstat` must NOT follow the leaf, so the symlink node
    // itself MUST still be statable.
    await vfs.symlink('/shared/real-file', '/shared/legit-symlink');

    restricted = new RestrictedFS(vfs, [scoopFolder, '/shared/', cwd], ['/workspace/']);
  });

  afterAll(async () => {
    await vfs.dispose();
  });

  it('async lstat through an escape-symlink ancestor throws ENOENT (no metadata leak)', async () => {
    // /shared/escape-link -> /scoops/other-scoop (escape target NOT in ACL).
    // `lstat('/shared/escape-link/secret')` would traverse the symlinked
    // ancestor and leak the sibling scoop's file metadata. The fix must
    // reject with ENOENT.
    await expect(restricted.lstat('/shared/escape-link/secret')).rejects.toThrow('ENOENT');
  });

  it('async lstat through an escape-symlink ancestor throws ENOENT for a non-existent leaf too', async () => {
    // Even when the leaf name does not exist on the escape target,
    // traversing the ancestor symlink is itself a leak vector — the
    // ACL check must happen BEFORE the delegate call so the error
    // path is indistinguishable from a regular ENOENT.
    await expect(restricted.lstat('/shared/escape-link/does-not-exist')).rejects.toThrow('ENOENT');
  });

  it('async lstat on the escape symlink node itself still reports symlink (does not follow leaf)', async () => {
    // The leaf IS the symlink. `lstat` must not follow it — the parent
    // `/shared` is inside the ACL, so the node's metadata is safe to
    // return.
    const s = await restricted.lstat('/shared/escape-link');
    expect(s.type).toBe('symlink');
  });

  it('regression: async lstat on a legitimate in-sandbox symlink still returns symlink stats', async () => {
    // /shared/legit-symlink -> /shared/real-file. Both are inside the
    // ACL. `lstat` does not follow the leaf symlink, so the call must
    // return Stats whose type is 'symlink' (NOT 'file'). A
    // naive "resolve leaf via realpath" fix would break this case.
    const s = await restricted.lstat('/shared/legit-symlink');
    expect(s.type).toBe('symlink');
  });

  it('regression: async lstat on a regular file inside the ACL returns file stats', async () => {
    const s = await restricted.lstat('/shared/real-file');
    expect(s.type).toBe('file');
  });

  it('regression: async lstat on a disallowed path throws ENOENT (lexical ACL still holds)', async () => {
    await expect(restricted.lstat('/scoops/other-scoop/secret')).rejects.toThrow('ENOENT');
  });
});

/**
 * Shell-level end-to-end confirmation: commands that hit
 * `VfsAdapter.lstat()`'s async fallback path (e.g., `stat`, `ls -l`)
 * must not leak sibling-scoop metadata through the escape-symlink
 * ancestor.
 */
describe('RestrictedFS async-lstat shell integration (VAL-FS-019 parity)', () => {
  let vfs: VirtualFS;
  let restricted: RestrictedFS;
  let shell: WasmShell;
  const scoopFolder = '/scoops/agent-async-lstat-shell/';
  const cwd = '/home/wiki/';

  beforeAll(async () => {
    vfs = await VirtualFS.create({
      dbName: 'test-restricted-fs-async-lstat-shell',
      wipe: true,
    });
    await vfs.mkdir('/scoops/agent-async-lstat-shell/workspace', { recursive: true });
    await vfs.mkdir('/shared', { recursive: true });
    await vfs.mkdir('/workspace', { recursive: true });
    await vfs.mkdir('/home/wiki', { recursive: true });
    await vfs.mkdir('/scoops/other-scoop', { recursive: true });

    await vfs.writeFile('/scoops/other-scoop/secret-file', 'SIBLING SCOOP SECRET');
    await vfs.writeFile('/shared/real-file', 'shared real contents');

    // Escape symlink inside /shared/ pointing at a sibling scoop's folder.
    await vfs.symlink('/scoops/other-scoop', '/shared/escape-link');

    restricted = new RestrictedFS(vfs, [scoopFolder, '/shared/', cwd], ['/workspace/']);
    shell = new WasmShell({
      fs: restricted as unknown as VirtualFS,
      cwd,
    });
  });

  afterAll(async () => {
    await vfs.dispose();
  });

  it('`stat /shared/escape-link/secret-file` fails gracefully and does NOT leak sibling metadata', async () => {
    // `stat` typically uses lstat on the final component. Even if the
    // shell's `stat` implementation ultimately calls stat(), the
    // VfsAdapter sync fast path returns null (ancestor is a symlink)
    // and falls back to async `lstat()` / `stat()`. Either way, the
    // result must be a non-zero exit and no metadata leak.
    const result = await shell.executeCommand('stat /shared/escape-link/secret-file');
    expect(result.stderr).not.toMatch(/TypeError/i);
    expect(result.exitCode).not.toBe(0);
    // Sibling scoop's file name / path MUST NOT appear on stdout (e.g.
    // as resolved canonical path or metadata line).
    expect(result.stdout).not.toContain('SIBLING SCOOP SECRET');
    expect(result.stdout).not.toContain('/scoops/other-scoop/secret-file');
  });
});
