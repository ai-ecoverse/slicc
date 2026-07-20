import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { convertError } from '../../src/fs/error-rebrand.js';
import { FsError, type FsErrorCode } from '../../src/fs/types.js';
import { resolveVfsBackendFromEnv, VirtualFS } from '../../src/fs/virtual-fs.js';

describe('VirtualFS — backend resolution', () => {
  let vfs: VirtualFS;
  beforeEach(async () => {
    vfs = await VirtualFS.create({ dbName: 'test-vfs-backend', wipe: true });
  });
  afterEach(async () => {
    await vfs.dispose();
  });

  it("falls back to 'memory' in Node test envs without OPFS support", () => {
    // The Node-test fallback uses ZenFS' `InMemory` backend (no
    // LightningFS). Node tests have no `navigator.storage`, so
    // resolution falls through to `'memory'`.
    expect(vfs.backend).toBe('memory');
  });

  it("resolveVfsBackendFromEnv returns 'memory' when navigator.storage is unavailable", () => {
    expect(resolveVfsBackendFromEnv()).toBe('memory');
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
    const memVfs = await VirtualFS.create({
      dbName: 'test-vfs-backend-explicit',
      wipe: true,
      backend: 'memory',
    });
    expect(memVfs.backend).toBe('memory');
    await memVfs.dispose();
  });
});

describe('VirtualFS — ZenFS ErrnoError → FsError mapping', () => {
  function mapErr(code: string): FsError {
    const e = new Error(`${code}: synthetic`) as Error & { code: string };
    e.code = code;
    return convertError(e, '/probe');
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
    const fe = convertError(new Error('weird ENOENT-ish thing'), '/probe');
    expect(fe.code).toBe('ENOENT');
  });

  it('returns EINVAL for an unknown error shape', () => {
    const fe = convertError(new Error('totally unknown'), '/probe');
    expect(fe.code).toBe('EINVAL');
  });
});
