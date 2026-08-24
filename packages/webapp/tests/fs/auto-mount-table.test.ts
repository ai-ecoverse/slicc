import { describe, expect, it, vi } from 'vitest';

import type { AutoMountFS } from '../../src/fs/auto-mount-table.js';
import {
  fetchAutoMounts,
  hostShadowedEntries,
  isCanonicalAbsoluteTarget,
  mountConfiguredHostMounts,
  withoutHostMountedTargets,
} from '../../src/fs/auto-mount-table.js';
import { HostFsMountBackend } from '../../src/fs/mount/backend-hostfs.js';

function fakeFetch(body: unknown, ok = true): typeof fetch {
  return vi.fn(async () => ({ ok, json: async () => body })) as unknown as typeof fetch;
}

function mockFs(
  existing: string[] = []
): AutoMountFS & { mounted: { path: string; backend: unknown }[] } {
  const mounted: { path: string; backend: unknown }[] = [];
  return {
    mounted,
    listMounts: () => existing,
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

  it('returns [] when the server is missing, errors, or has no table', async () => {
    await expect(fetchAutoMounts(fakeFetch({ trayJoinUrl: null }))).resolves.toEqual([]);
    await expect(fetchAutoMounts(fakeFetch({}, false))).resolves.toEqual([]);
    const failing = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    await expect(fetchAutoMounts(failing)).resolves.toEqual([]);
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
  });

  it('skips already-mounted targets', async () => {
    const fs = mockFs(['/mnt/a']);
    const mounted = await mountConfiguredHostMounts(
      fs,
      undefined,
      fakeFetch({ autoMounts: [{ path: '/mnt/a', hostPath: '/h/a' }] })
    );
    expect(mounted).toEqual([]);
    expect(fs.mounted).toEqual([]);
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
