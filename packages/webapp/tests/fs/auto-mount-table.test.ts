import { describe, expect, it, vi } from 'vitest';

import type { AutoMountFS } from '../../src/fs/auto-mount-table.js';
import { fetchAutoMounts, mountConfiguredHostMounts } from '../../src/fs/auto-mount-table.js';
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

  it('drops malformed, relative, and root-target entries', async () => {
    const table = [
      { path: '/mnt/a', hostPath: '/h/a' },
      { path: 'rel', hostPath: '/h/b' },
      { path: '/', hostPath: '/h/c' },
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
