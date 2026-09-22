import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AutoMountBackendView, AutoMountFS } from '../../src/fs/auto-mount-table.js';
import {
  applyConfiguredHostMounts,
  fetchAutoMounts,
  hostShadowedEntries,
  isCanonicalAbsoluteTarget,
  mountConfiguredHostMounts,
  purgeShadowedHostMountState,
  shadowedPendingMountKeys,
  withoutHostMountedTargets,
} from '../../src/fs/auto-mount-table.js';
import { HostFsMountBackend, hostFsMountId } from '../../src/fs/mount/backend-hostfs.js';
import { loadAndClearPendingHandle, storePendingHandle } from '../../src/fs/mount-picker-popup.js';
import {
  getAllMountEntries,
  type MountTableEntry,
  saveMountEntry,
} from '../../src/fs/mount-table-store.js';

function fakeFetch(
  body: unknown,
  ok = true,
  extra: { status?: number; text?: string } = {}
): typeof fetch {
  return vi.fn(async () => ({
    ok,
    status: extra.status ?? (ok ? 200 : 500),
    json: async () => body,
    text: async () => extra.text ?? '',
  })) as unknown as typeof fetch;
}

function mockFs(
  existing: string[] = [],
  backends: Record<string, AutoMountBackendView> = {}
): AutoMountFS & {
  mounted: { path: string; backend: unknown }[];
  unmounted: string[];
} {
  const mounted: { path: string; backend: unknown }[] = [];
  const unmounted: string[] = [];
  return {
    mounted,
    unmounted,
    listMounts: () => existing,
    getMountBackend: (path: string) => backends[path] ?? null,
    unmount: (path: string) => {
      unmounted.push(path);
    },
    mount: (path: string, backend: unknown) => {
      mounted.push({ path, backend });
    },
  };
}

describe('fetchAutoMounts', () => {
  it('returns the mappings from runtime-config', async () => {
    const table = [{ path: '/mnt/a', hostPath: '/Users/me/a' }];
    await expect(fetchAutoMounts(fakeFetch({ autoMounts: table }))).resolves.toEqual(table);
  });

  it('drops malformed, relative, root, and non-canonical entries', async () => {
    const table = [
      { path: '/mnt/a', hostPath: '/h/a' },
      { path: 'rel', hostPath: '/h/b' },
      { path: '/', hostPath: '/h/c' },
      { path: '/mnt/x/../y', hostPath: '/h/e' },
      { path: '/mnt//y', hostPath: '/h/f' },
      { path: '/mnt/d' },
      'nope',
    ];
    await expect(fetchAutoMounts(fakeFetch({ autoMounts: table }))).resolves.toEqual([
      { path: '/mnt/a', hostPath: '/h/a' },
    ]);
  });

  it('returns [] quietly when the response has no table', async () => {
    const warn = vi.fn();
    await expect(fetchAutoMounts(fakeFetch({ trayJoinUrl: null }), { warn })).resolves.toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs status and body when runtime-config is not ok', async () => {
    const warn = vi.fn();
    const fetchImpl = fakeFetch({}, false, { status: 403, text: 'stale bridge token' });
    await expect(fetchAutoMounts(fetchImpl, { warn })).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith('Mount table fetch failed', {
      status: 403,
      body: 'stale bridge token',
    });
  });

  it('logs the error when the fetch throws', async () => {
    const warn = vi.fn();
    const failing = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    await expect(fetchAutoMounts(failing, { warn })).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith('Mount table fetch failed', { error: 'offline' });
  });

  it('truncates a long error body', async () => {
    const warn = vi.fn();
    await fetchAutoMounts(fakeFetch({}, false, { status: 500, text: 'x'.repeat(600) }), { warn });
    const detail = warn.mock.calls[0]?.[1] as { body: string };
    expect(detail.body.length).toBeLessThan(600);
    expect(detail.body.endsWith('…')).toBe(true);
  });
});

describe('mountConfiguredHostMounts', () => {
  it('mounts each table entry with a HostFsMountBackend', async () => {
    const fs = mockFs();
    const mounted = await mountConfiguredHostMounts(
      fs,
      undefined,
      fakeFetch({
        autoMounts: [
          { path: '/mnt/a', hostPath: '/h/a' },
          { path: '/mnt/b', hostPath: '/h/b' },
        ],
      })
    );
    expect(mounted.map((m) => m.path)).toEqual(['/mnt/a', '/mnt/b']);
    expect(fs.mounted.map((m) => m.path)).toEqual(['/mnt/a', '/mnt/b']);
    const backend = fs.mounted[0].backend as HostFsMountBackend;
    expect(backend).toBeInstanceOf(HostFsMountBackend);
    expect(backend.kind).toBe('hostfs');
    expect(backend.source).toBe('hostfs:///h/a');
    expect(backend.mountId).toBe(hostFsMountId('/mnt/a', '/h/a'));
  });

  it('keeps an existing hostfs mount of the same folder and still reports it owned', async () => {
    const fs = mockFs(['/mnt/a'], { '/mnt/a': { kind: 'hostfs', source: 'hostfs:///h/a' } });
    const mounted = await mountConfiguredHostMounts(
      fs,
      undefined,
      fakeFetch({ autoMounts: [{ path: '/mnt/a', hostPath: '/h/a' }] })
    );
    expect(mounted).toEqual([{ path: '/mnt/a', hostPath: '/h/a' }]);
    expect(fs.mounted).toEqual([]);
    expect(fs.unmounted).toEqual([]);
  });

  it('warns and does not claim a target it cannot unmount', async () => {
    const warn = vi.fn();
    const fs = mockFs(['/mnt/a'], { '/mnt/a': { kind: 'local' } });
    delete fs.unmount;
    const mounted = await mountConfiguredHostMounts(
      fs,
      { warn },
      fakeFetch({ autoMounts: [{ path: '/mnt/a', hostPath: '/h/a' }] })
    );
    expect(mounted).toEqual([]);
    expect(fs.mounted).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      'Configured host folder is blocked by an existing mount',
      expect.objectContaining({ path: '/mnt/a', kind: 'local' })
    );
  });

  it('replaces a non-hostfs mount at a config-owned target and leaves other mounts', async () => {
    const warn = vi.fn();
    const fs = mockFs(['/mnt/kb', '/mnt/other'], {
      '/mnt/kb': { kind: 'local' },
      '/mnt/other': { kind: 's3', source: 's3://bucket' },
    });
    const mounted = await mountConfiguredHostMounts(
      fs,
      { warn },
      fakeFetch({ autoMounts: [{ path: '/mnt/kb', hostPath: '/Users/me/Desktop/kb' }] })
    );
    expect(fs.unmounted).toEqual(['/mnt/kb']);
    expect(mounted.map((m) => m.path)).toEqual(['/mnt/kb']);
    expect(fs.mounted.map((m) => m.path)).toEqual(['/mnt/kb']);
    expect((fs.mounted[0].backend as HostFsMountBackend).kind).toBe('hostfs');
    expect(warn).toHaveBeenCalledWith(
      'Replaced a non-hostfs mount with the configured host folder',
      expect.objectContaining({ path: '/mnt/kb', replacedKind: 'local' })
    );
  });

  it('re-mounts hostfs when the configured host path changed', async () => {
    const info = vi.fn();
    const fs = mockFs(['/mnt/kb'], { '/mnt/kb': { kind: 'hostfs', source: 'hostfs:///old' } });
    const mounted = await mountConfiguredHostMounts(
      fs,
      { info },
      fakeFetch({ autoMounts: [{ path: '/mnt/kb', hostPath: '/new' }] })
    );
    expect(fs.unmounted).toEqual(['/mnt/kb']);
    expect(mounted).toEqual([{ path: '/mnt/kb', hostPath: '/new' }]);
    expect(info).toHaveBeenCalledWith(
      'Re-mounted host folder because the configured host path changed',
      expect.objectContaining({ hostPath: '/new', replacedKind: 'hostfs' })
    );
  });

  it('logs and skips a target whose unmount throws', async () => {
    const warn = vi.fn();
    const fs = mockFs(['/mnt/kb'], { '/mnt/kb': { kind: 'local' } });
    fs.unmount = () => {
      throw new Error('busy');
    };
    const mounted = await mountConfiguredHostMounts(
      fs,
      { warn },
      fakeFetch({ autoMounts: [{ path: '/mnt/kb', hostPath: '/h/kb' }] })
    );
    expect(mounted).toEqual([]);
    expect(fs.mounted).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      'Failed to unmount a mount blocking a config-owned target',
      expect.objectContaining({ path: '/mnt/kb', error: 'busy' })
    );
  });

  it('continues past a failing mount and logs it', async () => {
    const warn = vi.fn();
    const fs = mockFs();
    fs.mount = (path: string, backend: unknown) => {
      if (path === '/mnt/bad') throw new Error('EEXIST boom');
      fs.mounted.push({ path, backend });
    };
    const mounted = await mountConfiguredHostMounts(
      fs,
      { warn },
      fakeFetch({
        autoMounts: [
          { path: '/mnt/bad', hostPath: '/h/bad' },
          { path: '/mnt/ok', hostPath: '/h/ok' },
        ],
      })
    );
    expect(mounted.map((m) => m.path)).toEqual(['/mnt/ok']);
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('isCanonicalAbsoluteTarget', () => {
  it('accepts only canonical absolute non-root paths', () => {
    expect(isCanonicalAbsoluteTarget('/mnt/a')).toBe(true);
    expect(isCanonicalAbsoluteTarget('/')).toBe(false);
    expect(isCanonicalAbsoluteTarget('rel')).toBe(false);
    expect(isCanonicalAbsoluteTarget('/mnt/a/../b')).toBe(false);
    expect(isCanonicalAbsoluteTarget('/mnt/./b')).toBe(false);
    expect(isCanonicalAbsoluteTarget('/mnt//b')).toBe(false);
    expect(isCanonicalAbsoluteTarget('/mnt/a/')).toBe(false);
  });
});

describe('withoutHostMountedTargets', () => {
  it('drops persisted entries whose target is config-owned, keeping the rest', () => {
    const entries = [
      { targetPath: '/mnt/kb' },
      { targetPath: '/mnt/kb/' },
      { targetPath: '/mnt/other' },
    ];
    expect(withoutHostMountedTargets(entries, [{ path: '/mnt/kb', hostPath: '/h/kb' }])).toEqual([
      { targetPath: '/mnt/other' },
    ]);
    expect(withoutHostMountedTargets(entries, [])).toEqual(entries);
  });
});

describe('hostShadowedEntries', () => {
  it('returns exactly the rows a configured host mount shadows', () => {
    const entries = [
      { targetPath: '/mnt/kb' },
      { targetPath: '/mnt/kb/' }, // trailing slash still matches the target
      { targetPath: '/mnt/other' },
    ];
    const mounted = [{ path: '/mnt/kb', hostPath: '/Users/me/Desktop/kb' }];
    // Complement invariant: shadowed + kept === all, with no overlap — the
    // purge must delete precisely what withoutHostMountedTargets filters.
    expect(hostShadowedEntries(entries, mounted)).toEqual([
      { targetPath: '/mnt/kb' },
      { targetPath: '/mnt/kb/' },
    ]);
    expect(withoutHostMountedTargets(entries, mounted)).toEqual([{ targetPath: '/mnt/other' }]);
  });

  it('returns [] with no configured host mounts', () => {
    expect(hostShadowedEntries([{ targetPath: '/mnt/kb' }], [])).toEqual([]);
  });
});

describe('shadowedPendingMountKeys', () => {
  it('names the panel terminal key and a trailing-slash variant', () => {
    expect(shadowedPendingMountKeys(['/mnt/kb', '/mnt/kb/'])).toEqual([
      'pendingMount:term:/mnt/kb',
      'pendingMount:term:/mnt/kb/',
    ]);
    expect(shadowedPendingMountKeys(['/'])).toEqual([]);
  });
});

describe('purgeShadowedHostMountState', () => {
  const owned = [{ path: '/mnt/kb', hostPath: '/Users/me/Desktop/kb' }];

  it('does nothing when no config mount landed', async () => {
    const loadEntries = vi.fn();
    await purgeShadowedHostMountState([], undefined, {
      loadEntries,
      removeMountEntry: vi.fn(),
      clearPendingHandle: vi.fn(),
    });
    expect(loadEntries).not.toHaveBeenCalled();
  });

  it('purges the shadowed row and the pending handle, keeping other targets', async () => {
    const removed: string[] = [];
    const cleared: string[] = [];
    await purgeShadowedHostMountState(owned, undefined, {
      loadEntries: async () => [{ targetPath: '/mnt/kb' }, { targetPath: '/mnt/other' }],
      removeMountEntry: async (path) => {
        removed.push(path);
      },
      clearPendingHandle: async (key) => {
        cleared.push(key);
      },
    });
    expect(removed).toEqual(['/mnt/kb']);
    expect(cleared).toEqual(['pendingMount:term:/mnt/kb']);
    expect(cleared.some((key) => key.includes('/mnt/other'))).toBe(false);
  });

  it('clears an armed pending handle even when no mount-table row exists', async () => {
    const cleared: string[] = [];
    await purgeShadowedHostMountState(owned, undefined, {
      loadEntries: async () => [],
      removeMountEntry: async () => {
        throw new Error('should not remove');
      },
      clearPendingHandle: async (key) => {
        cleared.push(key);
      },
    });
    expect(cleared).toEqual(['pendingMount:term:/mnt/kb']);
  });

  it('logs a failed row delete and a failed handle clear, and continues', async () => {
    const warn = vi.fn();
    await purgeShadowedHostMountState(
      owned,
      { warn },
      {
        loadEntries: async () => [{ targetPath: '/mnt/kb/' }],
        removeMountEntry: async () => {
          throw new Error('idb down');
        },
        clearPendingHandle: async () => {
          throw new Error('pending down');
        },
      }
    );
    expect(warn).toHaveBeenCalledWith(
      'Failed to purge host-owned mount row',
      expect.objectContaining({ path: '/mnt/kb/', error: 'idb down' })
    );
    expect(warn).toHaveBeenCalledWith(
      'Failed to clear a shadowed pending-mount handle',
      expect.objectContaining({ error: 'pending down' })
    );
  });

  it('still clears pending handles when the mount table cannot be read', async () => {
    const warn = vi.fn();
    const cleared: string[] = [];
    await purgeShadowedHostMountState(
      owned,
      { warn },
      {
        loadEntries: async () => {
          throw new Error('store locked');
        },
        removeMountEntry: vi.fn(),
        clearPendingHandle: async (key) => {
          cleared.push(key);
        },
      }
    );
    expect(cleared).toEqual(['pendingMount:term:/mnt/kb']);
    expect(warn).toHaveBeenCalledWith(
      'Failed to read persisted mounts while claiming config-owned targets',
      expect.objectContaining({ error: 'store locked' })
    );
  });
});

describe('applyConfiguredHostMounts', () => {
  function handle(name: string): FileSystemDirectoryHandle {
    return { kind: 'directory', name } as unknown as FileSystemDirectoryHandle;
  }

  async function dropDb(name: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () => resolve();
    });
  }

  beforeEach(async () => {
    await dropDb('slicc-mount-table');
    await dropDb('slicc-pending-mount');
  });

  it('mounts the table, drops the shadowed row, and clears the pending handle', async () => {
    const kb: MountTableEntry = {
      targetPath: '/mnt/kb',
      descriptor: { kind: 'local', mountId: 'local-kb', idbHandleKey: '/mnt/kb' },
      createdAt: 1,
    };
    const other: MountTableEntry = {
      targetPath: '/mnt/other',
      descriptor: { kind: 's3', mountId: 's3-other', source: 's3://bucket', profile: 'default' },
      createdAt: 2,
    };
    await saveMountEntry(kb);
    await saveMountEntry(other);
    await storePendingHandle('pendingMount:term:/mnt/kb', handle('kb'));
    await storePendingHandle('pendingMount:term:/mnt/other', handle('other'));

    const fs = mockFs(['/mnt/kb'], { '/mnt/kb': { kind: 'local' } });
    const mounted = await applyConfiguredHostMounts(
      fs,
      undefined,
      fakeFetch({ autoMounts: [{ path: '/mnt/kb', hostPath: '/Users/me/Desktop/kb' }] })
    );

    expect(mounted.map((m) => m.path)).toEqual(['/mnt/kb']);
    expect(fs.unmounted).toEqual(['/mnt/kb']);
    const left = (await getAllMountEntries()).map((entry) => entry.targetPath).sort();
    expect(left).toEqual(['/mnt/other']);
    expect(await loadAndClearPendingHandle('pendingMount:term:/mnt/kb')).toBeNull();
    expect((await loadAndClearPendingHandle('pendingMount:term:/mnt/other'))?.name).toBe('other');
  });
});
