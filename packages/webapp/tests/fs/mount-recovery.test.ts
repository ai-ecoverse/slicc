import { describe, it, expect, vi } from 'vitest';
import {
  recoverMounts,
  formatMountRecoveryPrompt,
  type MountRecoveryFS,
} from '../../src/fs/mount-recovery.js';
import type { MountEntry } from '../../src/fs/mount-table-store.js';

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

function mockFs(mountImpl?: (path: string, handle: FileSystemDirectoryHandle) => Promise<void>): {
  fs: MountRecoveryFS;
  mounts: Array<{ path: string; name: string }>;
} {
  const mounts: Array<{ path: string; name: string }> = [];
  const fs: MountRecoveryFS = {
    mount: async (path: string, handle: FileSystemDirectoryHandle) => {
      if (mountImpl) await mountImpl(path, handle);
      mounts.push({ path, name: handle.name });
    },
  };
  return { fs, mounts };
}

describe('recoverMounts', () => {
  it('silently remounts handles whose permission is still granted', async () => {
    const entries: MountEntry[] = [
      { path: '/workspace/a', handle: mockHandle({ name: 'a', permission: 'granted' }) },
      { path: '/workspace/b', handle: mockHandle({ name: 'b', permission: 'granted' }) },
    ];
    const { fs, mounts } = mockFs();
    const result = await recoverMounts(entries, fs);
    expect(result.restored).toEqual([
      { path: '/workspace/a', dirName: 'a' },
      { path: '/workspace/b', dirName: 'b' },
    ]);
    expect(result.needsRecovery).toEqual([]);
    expect(mounts).toEqual([
      { path: '/workspace/a', name: 'a' },
      { path: '/workspace/b', name: 'b' },
    ]);
  });

  it('flags handles whose permission dropped to `prompt` as needing recovery', async () => {
    const entries: MountEntry[] = [
      { path: '/workspace/a', handle: mockHandle({ name: 'a', permission: 'prompt' }) },
      { path: '/workspace/b', handle: mockHandle({ name: 'b', permission: 'denied' }) },
    ];
    const { fs, mounts } = mockFs();
    const result = await recoverMounts(entries, fs);
    expect(result.restored).toEqual([]);
    expect(result.needsRecovery).toEqual([
      { path: '/workspace/a', dirName: 'a' },
      { path: '/workspace/b', dirName: 'b' },
    ]);
    expect(mounts).toEqual([]);
  });

  it('flags handles that lost `queryPermission` as needing recovery', async () => {
    const entries: MountEntry[] = [
      {
        path: '/workspace/legacy',
        handle: mockHandle({ name: 'legacy', withoutQueryPermission: true }),
      },
    ];
    const { fs } = mockFs();
    const result = await recoverMounts(entries, fs);
    expect(result.restored).toEqual([]);
    expect(result.needsRecovery).toEqual([{ path: '/workspace/legacy', dirName: 'legacy' }]);
  });

  it('flags handles whose queryPermission throws as needing recovery', async () => {
    const warn = vi.fn();
    const entries: MountEntry[] = [
      {
        path: '/workspace/broken',
        handle: mockHandle({ name: 'broken', throwOnQuery: true }),
      },
    ];
    const { fs } = mockFs();
    const result = await recoverMounts(entries, fs, { warn });
    expect(result.restored).toEqual([]);
    expect(result.needsRecovery).toEqual([{ path: '/workspace/broken', dirName: 'broken' }]);
    expect(warn).toHaveBeenCalledWith(
      'queryPermission threw on persisted handle',
      expect.objectContaining({ path: '/workspace/broken' })
    );
  });

  it('falls back to needsRecovery when the fs mount call itself throws', async () => {
    const warn = vi.fn();
    const entries: MountEntry[] = [
      { path: '/workspace/x', handle: mockHandle({ name: 'x', permission: 'granted' }) },
    ];
    const fs: MountRecoveryFS = {
      mount: async () => {
        throw new Error('mount failed');
      },
    };
    const result = await recoverMounts(entries, fs, { warn });
    expect(result.restored).toEqual([]);
    expect(result.needsRecovery).toEqual([{ path: '/workspace/x', dirName: 'x' }]);
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
    const entries: MountEntry[] = [
      { path: '/workspace/ok', handle: mockHandle({ name: 'ok', permission: 'granted' }) },
      { path: '/workspace/stale', handle: mockHandle({ name: 'stale', permission: 'prompt' }) },
    ];
    const { fs } = mockFs();
    const result = await recoverMounts(entries, fs);
    expect(result.restored).toEqual([{ path: '/workspace/ok', dirName: 'ok' }]);
    expect(result.needsRecovery).toEqual([{ path: '/workspace/stale', dirName: 'stale' }]);
  });
});

describe('formatMountRecoveryPrompt', () => {
  it('returns null when there are no mounts to recover', () => {
    expect(formatMountRecoveryPrompt([])).toBeNull();
  });

  it('returns null for non-array input (defensive)', () => {
    expect(formatMountRecoveryPrompt(undefined as unknown as [])).toBeNull();
  });

  it('produces a single-mount prompt that includes the mount command', () => {
    const prompt = formatMountRecoveryPrompt([
      { path: '/workspace/my-project', dirName: 'my-project' },
    ]);
    expect(prompt).not.toBeNull();
    expect(prompt).toContain('Mount recovery required');
    expect(prompt).toContain('1 mount point');
    expect(prompt).toContain('/workspace/my-project');
    expect(prompt).toContain('previously mounted from `my-project`');
    expect(prompt).toContain('mount /workspace/my-project');
    expect(prompt).toContain('mount unmount');
  });

  it('pluralizes when multiple mounts need recovery', () => {
    const prompt = formatMountRecoveryPrompt([
      { path: '/workspace/a', dirName: 'a' },
      { path: '/workspace/b', dirName: 'b' },
    ]);
    expect(prompt).not.toBeNull();
    expect(prompt).toContain('2 mount points');
    expect(prompt).toContain('mount /workspace/a');
    expect(prompt).toContain('mount /workspace/b');
  });

  it('omits the original directory name when it is unknown', () => {
    const prompt = formatMountRecoveryPrompt([{ path: '/mnt/data', dirName: '' }]);
    expect(prompt).not.toBeNull();
    expect(prompt).not.toContain('previously mounted');
    expect(prompt).toContain('/mnt/data');
  });
});
