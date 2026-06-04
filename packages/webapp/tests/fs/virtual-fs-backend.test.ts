import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsError, type FsErrorCode } from '../../src/fs/types.js';
import { resolveVfsBackendFromEnv, VirtualFS } from '../../src/fs/virtual-fs.js';

describe('VirtualFS — backend flag plumbing (Wave A2)', () => {
  let vfs: VirtualFS;
  beforeEach(async () => {
    vfs = await VirtualFS.create({ dbName: 'test-vfs-backend', wipe: true });
  });
  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 600));
  });

  it("defaults to 'lfs' when no backend option and no localStorage flag is set", () => {
    expect(vfs.backend).toBe('lfs');
  });

  it("resolveVfsBackendFromEnv returns 'lfs' when localStorage has no flag", () => {
    expect(resolveVfsBackendFromEnv()).toBe('lfs');
  });

  it("resolveVfsBackendFromEnv returns 'opfs' when localStorage.slicc_opfs_vfs === 'opfs'", () => {
    const store = new Map<string, string>([['slicc_opfs_vfs', 'opfs']]);
    const original = (globalThis as { localStorage?: Storage }).localStorage;
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: () => {},
        removeItem: () => {},
        clear: () => {},
        key: () => null,
        length: 0,
      },
    });
    try {
      expect(resolveVfsBackendFromEnv()).toBe('opfs');
    } finally {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: original,
      });
    }
  });

  it('an explicit backend option overrides the env flag', async () => {
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
