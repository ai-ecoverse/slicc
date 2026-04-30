import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests stub the IDB-backed mount-table-store so handles with function
 * properties (queryPermission) survive intact — the real fake-indexeddb
 * strips functions during its structured clone, which would defeat the
 * permission-check tests below.
 *
 * The stub also seeds a default empty `loadMountHandle` per test; tests
 * that need a specific handle override `handleByKey` before calling
 * recoverMounts.
 */
const handleByKey = new Map<string, FileSystemDirectoryHandle>();
vi.mock('../../src/fs/mount-table-store.js', async () => {
  return {
    loadMountHandle: async (key: string) => handleByKey.get(key) ?? null,
    // Type-only re-exports for the test's TypeScript imports.
  };
});

import {
  recoverMounts,
  formatMountRecoveryPrompt,
  mdInlineCode,
  shellQuote,
  type MountRecoveryFS,
  type MountRecoveryEntry,
} from '../../src/fs/mount-recovery.js';
import { newMountId } from '../../src/fs/mount/mount-id.js';
import type { MountBackend } from '../../src/fs/mount/backend.js';
import { LocalMountBackend } from '../../src/fs/mount/backend-local.js';

interface MountTableEntry {
  targetPath: string;
  descriptor:
    | { kind: 'local'; mountId: string; idbHandleKey: string }
    | { kind: 's3'; mountId: string; source: string; profile: string }
    | { kind: 'da'; mountId: string; source: string; profile: string };
  createdAt: number;
}

type PermissionState = 'granted' | 'prompt' | 'denied';

interface MockHandleOptions {
  name: string;
  permission?: PermissionState;
  /** Omit `queryPermission` from the handle object (simulates stale/old record). */
  withoutQueryPermission?: boolean;
  /** Force `queryPermission` to throw. */
  throwOnQuery?: boolean;
}

function mockHandle(opts: MockHandleOptions): FileSystemDirectoryHandle {
  const { name, permission = 'granted', withoutQueryPermission, throwOnQuery } = opts;
  const handle: Record<string, unknown> = { kind: 'directory', name };
  if (!withoutQueryPermission) {
    handle.queryPermission = async (_desc: { mode: string }) => {
      if (throwOnQuery) throw new Error('boom');
      return permission;
    };
  }
  return handle as unknown as FileSystemDirectoryHandle;
}

/**
 * Build a local-backend MountTableEntry and stash the handle in the
 * `handleByKey` map so the mocked `loadMountHandle` returns it.
 */
function seedLocalEntry(targetPath: string, handle: FileSystemDirectoryHandle): MountTableEntry {
  const entry: MountTableEntry = {
    targetPath,
    descriptor: {
      kind: 'local',
      mountId: newMountId(),
      idbHandleKey: targetPath,
    },
    createdAt: Date.now(),
  };
  handleByKey.set(targetPath, handle);
  return entry;
}

function mockFs(mountImpl?: (path: string, backend: MountBackend) => Promise<void>): {
  fs: MountRecoveryFS;
  mounts: Array<{ path: string; name: string }>;
} {
  const mounts: Array<{ path: string; name: string }> = [];
  const fs: MountRecoveryFS = {
    mount: async (path: string, backend: MountBackend) => {
      if (mountImpl) await mountImpl(path, backend);
      const desc = backend.describe();
      mounts.push({ path, name: desc.displayName });
    },
  };
  return { fs, mounts };
}

describe('recoverMounts', () => {
  beforeEach(() => {
    handleByKey.clear();
  });

  it('silently remounts handles whose permission is still granted', async () => {
    const a = seedLocalEntry('/workspace/a', mockHandle({ name: 'a', permission: 'granted' }));
    const b = seedLocalEntry('/workspace/b', mockHandle({ name: 'b', permission: 'granted' }));
    const { fs, mounts } = mockFs();
    const result = await recoverMounts([a, b], fs);
    expect(result.restored).toEqual([
      { kind: 'local', path: '/workspace/a', dirName: 'a' },
      { kind: 'local', path: '/workspace/b', dirName: 'b' },
    ]);
    expect(result.needsRecovery).toEqual([]);
    expect(mounts).toEqual([
      { path: '/workspace/a', name: 'a' },
      { path: '/workspace/b', name: 'b' },
    ]);
  });

  it('flags handles whose permission dropped to `prompt` as needing recovery', async () => {
    const a = seedLocalEntry('/workspace/a', mockHandle({ name: 'a', permission: 'prompt' }));
    const b = seedLocalEntry('/workspace/b', mockHandle({ name: 'b', permission: 'denied' }));
    const { fs, mounts } = mockFs();
    const result = await recoverMounts([a, b], fs);
    expect(result.restored).toEqual([]);
    expect(result.needsRecovery).toEqual([
      { kind: 'local', path: '/workspace/a', dirName: 'a' },
      { kind: 'local', path: '/workspace/b', dirName: 'b' },
    ]);
    expect(mounts).toEqual([]);
  });

  it('flags handles that lost `queryPermission` as needing recovery', async () => {
    const e = seedLocalEntry(
      '/workspace/legacy',
      mockHandle({ name: 'legacy', withoutQueryPermission: true })
    );
    const { fs } = mockFs();
    const result = await recoverMounts([e], fs);
    expect(result.restored).toEqual([]);
    expect(result.needsRecovery).toEqual([
      { kind: 'local', path: '/workspace/legacy', dirName: 'legacy' },
    ]);
  });

  it('flags handles whose queryPermission throws as needing recovery', async () => {
    const warn = vi.fn();
    const e = seedLocalEntry(
      '/workspace/broken',
      mockHandle({ name: 'broken', throwOnQuery: true })
    );
    const { fs } = mockFs();
    const result = await recoverMounts([e], fs, { warn });
    expect(result.restored).toEqual([]);
    expect(result.needsRecovery).toEqual([
      { kind: 'local', path: '/workspace/broken', dirName: 'broken' },
    ]);
    expect(warn).toHaveBeenCalledWith(
      'queryPermission threw on persisted handle',
      expect.objectContaining({ path: '/workspace/broken' })
    );
  });

  it('falls back to needsRecovery when the fs mount call itself throws', async () => {
    const warn = vi.fn();
    const e = seedLocalEntry('/workspace/x', mockHandle({ name: 'x', permission: 'granted' }));
    const fs: MountRecoveryFS = {
      mount: async () => {
        throw new Error('mount failed');
      },
    };
    const result = await recoverMounts([e], fs, { warn });
    expect(result.restored).toEqual([]);
    expect(result.needsRecovery).toEqual([{ kind: 'local', path: '/workspace/x', dirName: 'x' }]);
    expect(warn).toHaveBeenCalledWith(
      'Failed to re-mount persisted handle',
      expect.objectContaining({ path: '/workspace/x' })
    );
  });

  it('returns empty arrays when there are no entries', async () => {
    const { fs } = mockFs();
    const result = await recoverMounts([], fs);
    expect(result).toEqual({ restored: [], needsRecovery: [] });
  });

  it('mixes restored and needs-recovery correctly in a single pass', async () => {
    const ok = seedLocalEntry('/workspace/ok', mockHandle({ name: 'ok', permission: 'granted' }));
    const stale = seedLocalEntry(
      '/workspace/stale',
      mockHandle({ name: 'stale', permission: 'prompt' })
    );
    const { fs } = mockFs();
    const result = await recoverMounts([ok, stale], fs);
    expect(result.restored).toEqual([{ kind: 'local', path: '/workspace/ok', dirName: 'ok' }]);
    expect(result.needsRecovery).toEqual([
      { kind: 'local', path: '/workspace/stale', dirName: 'stale' },
    ]);
  });

  it('restored backends are LocalMountBackend instances passed to fs.mount', async () => {
    const e = seedLocalEntry('/workspace/x', mockHandle({ name: 'x', permission: 'granted' }));
    let received: MountBackend | undefined;
    const fs: MountRecoveryFS = {
      mount: async (_path, backend) => {
        received = backend;
      },
    };
    await recoverMounts([e], fs);
    expect(received).toBeInstanceOf(LocalMountBackend);
    expect(received?.kind).toBe('local');
    expect(received?.mountId).toBe(e.descriptor.kind === 'local' ? e.descriptor.mountId : '');
  });

  it('routes s3 descriptors to needsRecovery (Phase 11 stub)', async () => {
    const entry: MountTableEntry = {
      targetPath: '/mnt/r2',
      descriptor: {
        kind: 's3',
        mountId: newMountId(),
        source: 's3://bucket/prefix',
        profile: 'r2',
      },
      createdAt: Date.now(),
    };
    const { fs } = mockFs();
    const result = await recoverMounts([entry], fs);
    expect(result.needsRecovery).toEqual([
      {
        kind: 's3',
        path: '/mnt/r2',
        source: 's3://bucket/prefix',
        profile: 'r2',
        reason: expect.stringContaining('not yet implemented'),
      },
    ]);
  });

  it('routes da descriptors to needsRecovery (Phase 12 stub)', async () => {
    const entry: MountTableEntry = {
      targetPath: '/mnt/da',
      descriptor: {
        kind: 'da',
        mountId: newMountId(),
        source: 'da://my-org/my-repo',
        profile: 'default',
      },
      createdAt: Date.now(),
    };
    const { fs } = mockFs();
    const result = await recoverMounts([entry], fs);
    expect(result.needsRecovery).toEqual([
      {
        kind: 'da',
        path: '/mnt/da',
        source: 'da://my-org/my-repo',
        profile: 'default',
        reason: expect.stringContaining('not yet implemented'),
      },
    ]);
  });
});

describe('formatMountRecoveryPrompt', () => {
  function localEntry(path: string, dirName: string): MountRecoveryEntry {
    return { kind: 'local', path, dirName };
  }

  it('returns null when there are no mounts to recover', () => {
    expect(formatMountRecoveryPrompt([])).toBeNull();
  });

  it('returns null for non-array input (defensive)', () => {
    expect(formatMountRecoveryPrompt(undefined as unknown as [])).toBeNull();
  });

  it('produces a single-mount prompt that includes the mount command', () => {
    const prompt = formatMountRecoveryPrompt([localEntry('/workspace/my-project', 'my-project')]);
    expect(prompt).not.toBeNull();
    expect(prompt).toContain('Mount recovery required');
    expect(prompt).toContain('1 mount point');
    expect(prompt).toContain('`/workspace/my-project`');
    expect(prompt).toContain('previously mounted from `my-project`');
    expect(prompt).toContain("mount '/workspace/my-project'");
    expect(prompt).toContain('mount unmount');
  });

  it('pluralizes when multiple mounts need recovery', () => {
    const prompt = formatMountRecoveryPrompt([
      localEntry('/workspace/a', 'a'),
      localEntry('/workspace/b', 'b'),
    ]);
    expect(prompt).not.toBeNull();
    expect(prompt).toContain('2 mount points');
    expect(prompt).toContain("mount '/workspace/a'");
    expect(prompt).toContain("mount '/workspace/b'");
  });

  it('omits the original directory name when it is unknown', () => {
    const prompt = formatMountRecoveryPrompt([localEntry('/mnt/data', '')]);
    expect(prompt).not.toBeNull();
    expect(prompt).not.toContain('previously mounted');
    expect(prompt).toContain('/mnt/data');
  });

  it('shell-quotes mount paths containing spaces so they parse as one argv token', () => {
    const prompt = formatMountRecoveryPrompt([localEntry('/mnt/My Project', 'My Project')]);
    expect(prompt).not.toBeNull();
    expect(prompt).toContain("mount '/mnt/My Project'");
    expect(prompt).not.toMatch(/^ {4}mount \/mnt\/My Project$/m);
  });

  it('escapes single quotes inside shell-quoted mount paths', () => {
    const prompt = formatMountRecoveryPrompt([localEntry("/mnt/It's Work", "It's Work")]);
    expect(prompt).not.toBeNull();
    expect(prompt).toContain("mount '/mnt/It'\\''s Work'");
  });

  it('uses a wider backtick delimiter when a value contains backticks', () => {
    const prompt = formatMountRecoveryPrompt([localEntry('/mnt/weird`path', 'weird`dir')]);
    expect(prompt).not.toBeNull();
    expect(prompt).toContain('``/mnt/weird`path``');
    expect(prompt).toContain('``weird`dir``');
  });

  it('collapses newlines inside Markdown inline code so the bullet renders on one line', () => {
    const prompt = formatMountRecoveryPrompt([localEntry('/mnt/line1\nline2', 'weird\r\nname')]);
    expect(prompt).not.toBeNull();
    expect(prompt).toContain('`/mnt/line1 line2`');
    expect(prompt).toContain('`weird name`');
  });

  it('formats s3 entries with retry hint including --source and --profile', () => {
    const prompt = formatMountRecoveryPrompt([
      {
        kind: 's3',
        path: '/mnt/r2',
        source: 's3://my-bucket/prefix',
        profile: 'r2',
        reason: 'profile r2 missing access_key_id',
      },
    ]);
    expect(prompt).not.toBeNull();
    expect(prompt).toContain('s3://my-bucket/prefix');
    expect(prompt).toContain("mount --source 's3://my-bucket/prefix' --profile 'r2' '/mnt/r2'");
    expect(prompt).toContain('profile r2 missing access_key_id');
  });

  it('formats da entries with retry hint and IMS identity context', () => {
    const prompt = formatMountRecoveryPrompt([
      {
        kind: 'da',
        path: '/mnt/da',
        source: 'da://my-org/my-repo',
        profile: 'default',
        reason: 'IMS token expired',
      },
    ]);
    expect(prompt).not.toBeNull();
    expect(prompt).toContain('da://my-org/my-repo');
    // Default profile omits the --profile flag from the retry hint.
    expect(prompt).toContain("mount --source 'da://my-org/my-repo' '/mnt/da'");
    expect(prompt).toContain('IMS token expired');
  });
});

describe('shellQuote', () => {
  it('wraps plain values in single quotes', () => {
    expect(shellQuote('/workspace/app')).toBe("'/workspace/app'");
  });

  it('preserves spaces inside the quoted form', () => {
    expect(shellQuote('/mnt/My Project')).toBe("'/mnt/My Project'");
  });

  it('escapes embedded single quotes using the POSIX close-reopen trick', () => {
    expect(shellQuote("It's")).toBe("'It'\\''s'");
  });

  it('handles strings with only single quotes', () => {
    expect(shellQuote("'")).toBe("''\\'''");
  });

  it('handles empty strings', () => {
    expect(shellQuote('')).toBe("''");
  });
});

describe('mdInlineCode', () => {
  it('wraps plain values in single backticks', () => {
    expect(mdInlineCode('/workspace/app')).toBe('`/workspace/app`');
  });

  it('uses a longer delimiter when the value contains a backtick', () => {
    expect(mdInlineCode('a`b')).toBe('``a`b``');
  });

  it('uses a still-longer delimiter when the value contains a run of backticks', () => {
    expect(mdInlineCode('a``b')).toBe('```a``b```');
  });

  it('pads leading/trailing backticks with a space so CommonMark parses cleanly', () => {
    expect(mdInlineCode('`leading')).toBe('`` `leading ``');
    expect(mdInlineCode('trailing`')).toBe('`` trailing` ``');
  });

  it('collapses CR/LF to a single space', () => {
    expect(mdInlineCode('line1\nline2')).toBe('`line1 line2`');
    expect(mdInlineCode('a\r\nb')).toBe('`a b`');
  });
});
