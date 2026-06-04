import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsError, type FsErrorCode } from '../../src/fs/types.js';
import { resolveVfsBackendFromEnv, VirtualFS } from '../../src/fs/virtual-fs.js';

describe('VirtualFS — backend resolution (Wave F1)', () => {
  let vfs: VirtualFS;
  beforeEach(async () => {
    vfs = await VirtualFS.create({ dbName: 'test-vfs-backend', wipe: true });
  });
  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 600));
  });

  it("falls back to 'lfs' in Node test envs without OPFS support", () => {
    // Wave F1: the `slicc_opfs_vfs` flag was removed; the resolver
    // now capability-detects OPFS via `navigator.storage.getDirectory`.
    // Node tests have no `navigator.storage`, so resolution falls
    // through to the still-importable LFS backend (F2 deletes it).
    expect(vfs.backend).toBe('lfs');
  });

  it("resolveVfsBackendFromEnv returns 'lfs' when navigator.storage is unavailable", () => {
    expect(resolveVfsBackendFromEnv()).toBe('lfs');
  });

  it("resolveVfsBackendFromEnv returns 'opfs' when navigator.storage.getDirectory exists", () => {
    const original = (globalThis as { navigator?: unknown }).navigator;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        storage: {
          getDirectory: () => Promise.resolve({}),
        },
      },
    });
    try {
      expect(resolveVfsBackendFromEnv()).toBe('opfs');
    } finally {
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: original,
      });
    }
  });

  it('an explicit backend option overrides env resolution', async () => {
    const lfsVfs = await VirtualFS.create({
      dbName: 'test-vfs-backend-explicit',
      wipe: true,
      backend: 'lfs',
    });
    expect(lfsVfs.backend).toBe('lfs');
    await lfsVfs.dispose();
  });
});

describe('VirtualFS — ZenFS ErrnoError → FsError mapping (Wave A4)', () => {
  let vfs: VirtualFS;
  beforeEach(async () => {
    vfs = await VirtualFS.create({ dbName: 'test-vfs-errno', wipe: true });
  });
  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 600));
  });

  function mapErr(code: string): FsError {
    const e = new Error(`${code}: synthetic`) as Error & { code: string };
    e.code = code;
    return (vfs as unknown as { convertError(err: unknown, path: string): FsError }).convertError(
      e,
      '/probe'
    );
  }

  const cases: FsErrorCode[] = [
    'ENOENT',
    'EEXIST',
    'ENOTDIR',
    'EISDIR',
    'ENOTEMPTY',
    'EINVAL',
    'EACCES',
    'ELOOP',
    'EBUSY',
    'EFBIG',
    'EBADF',
    'EIO',
  ];

  for (const code of cases) {
    it(`maps ZenFS .code='${code}' to FsError code='${code}'`, () => {
      const fe = mapErr(code);
      expect(fe).toBeInstanceOf(FsError);
      expect(fe.code).toBe(code);
      expect(fe.path).toBe('/probe');
    });
  }

  it('falls back to message substring matching when no .code is set', () => {
    const e = new Error('weird ENOENT-ish thing');
    const fe = (
      vfs as unknown as { convertError(err: unknown, path: string): FsError }
    ).convertError(e, '/probe');
    expect(fe.code).toBe('ENOENT');
  });

  it('returns EINVAL for an unknown error shape', () => {
    const fe = (
      vfs as unknown as { convertError(err: unknown, path: string): FsError }
    ).convertError(new Error('totally unknown'), '/probe');
    expect(fe.code).toBe('EINVAL');
  });
});
