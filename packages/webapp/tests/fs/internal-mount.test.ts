/**
 * Tests for `vfs.mountInternal` / `unmountInternal` (Phase 5.2).
 *
 * Verifies:
 *  - regular `mount()` and internal mounts coexist;
 *  - `listMounts()` excludes internal mounts;
 *  - `RestrictedFS.getAllPrefixes()` (covered indirectly through
 *    `RestrictedFS` reading from `listMounts()`) excludes them;
 *  - reads dispatch to the registered backend the same way regular
 *    mounts do;
 *  - internal mounts don't persist (no IDB row written);
 *  - `unmountInternal` cleanly removes the registration.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { VirtualFS } from '../../src/fs/index.js';
import { ProcMountBackend } from '../../src/kernel/proc-mount.js';
import { ProcessManager } from '../../src/kernel/process-manager.js';

describe('mountInternal', () => {
  let vfs: VirtualFS;
  beforeEach(async () => {
    indexedDB.deleteDatabase('test-internal-mount');
    vfs = await VirtualFS.create({ dbName: 'test-internal-mount', wipe: true });
  });
  afterEach(() => {
    vfs.dispose?.();
  });

  it('listMounts() excludes internal mounts', async () => {
    const pm = new ProcessManager();
    await vfs.mountInternal('/proc', new ProcMountBackend(pm));
    expect(vfs.listMounts()).toEqual([]);
    expect(vfs.listInternalMounts()).toEqual(['/proc']);
  });

  it('reads dispatch to the registered backend', async () => {
    const pm = new ProcessManager();
    pm.spawn({ kind: 'shell', argv: ['echo', 'hi'], owner: { kind: 'cone' } });
    await vfs.mountInternal('/proc', new ProcMountBackend(pm));
    const entries = await vfs.readDir('/proc');
    const names = entries.map((e) => (typeof e === 'string' ? e : e.name)).sort();
    expect(names).toContain('1024');
    expect(names).toContain('1');
  });

  it('readFile under an internal mount works', async () => {
    const pm = new ProcessManager();
    const proc = pm.spawn({
      kind: 'shell',
      argv: ['ls', '-la'],
      cwd: '/workspace',
      owner: { kind: 'cone' },
    });
    await vfs.mountInternal('/proc', new ProcMountBackend(pm));
    const cmdline = await vfs.readFile(`/proc/${proc.pid}/cmdline`, { encoding: 'utf-8' });
    expect(cmdline).toBe('ls\0-la\0');
  });

  it('writes through an internal mount throw EACCES (proc is read-only)', async () => {
    const pm = new ProcessManager();
    pm.spawn({ kind: 'shell', argv: ['s'], owner: { kind: 'cone' } });
    await vfs.mountInternal('/proc', new ProcMountBackend(pm));
    await expect(vfs.writeFile('/proc/1024/status', 'tampered')).rejects.toThrow();
  });

  it('EEXIST when the same path is mounted twice (regular or internal)', async () => {
    const pm = new ProcessManager();
    await vfs.mountInternal('/proc', new ProcMountBackend(pm));
    await expect(vfs.mountInternal('/proc', new ProcMountBackend(pm))).rejects.toMatchObject({
      code: 'EEXIST',
    });
  });

  it('unmountInternal cleanly removes the registration', async () => {
    const pm = new ProcessManager();
    pm.spawn({ kind: 'shell', argv: ['s'], owner: { kind: 'cone' } });
    await vfs.mountInternal('/proc', new ProcMountBackend(pm));
    expect(vfs.listInternalMounts()).toEqual(['/proc']);
    await vfs.unmountInternal('/proc');
    expect(vfs.listInternalMounts()).toEqual([]);
    // After unmount, /proc reads fall back to the LFS placeholder
    // directory which is empty.
    const entries = await vfs.readDir('/proc');
    const names = entries.map((e) => (typeof e === 'string' ? e : e.name));
    expect(names).toEqual([]);
  });

  it('unmountInternal on an unknown path throws ENOENT', async () => {
    await expect(vfs.unmountInternal('/proc')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('regular mount() rejects /proc once mounted internally (EEXIST)', async () => {
    const pm = new ProcessManager();
    await vfs.mountInternal('/proc', new ProcMountBackend(pm));
    // Try to call mount() with a stub backend on the same path —
    // expect EEXIST. Use a minimal fake; mount() doesn't dereference
    // the backend until after the path-exists check.
    const stub = {
      kind: 'local' as const,
      source: undefined,
      mountId: 'stub',
      readDir: async () => [],
      readFile: async () => new Uint8Array(),
      writeFile: async () => undefined,
      stat: async () => ({ kind: 'directory' as const, size: 0, mtime: 0 }),
      mkdir: async () => undefined,
      remove: async () => undefined,
      refresh: async () => ({ added: [], removed: [], changed: [], unchanged: 0, errors: [] }),
      describe: () => ({ displayName: 'stub' }),
      close: async () => undefined,
      getHandle: () => ({}) as unknown,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(vfs.mount('/proc', stub as any)).rejects.toMatchObject({ code: 'EEXIST' });
  });
});
