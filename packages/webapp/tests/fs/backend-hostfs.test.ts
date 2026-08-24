import { describe, expect, it, vi } from 'vitest';

import { HostFsMountBackend } from '../../src/fs/mount/backend-hostfs.js';
import { FsError } from '../../src/fs/types.js';

function backendWith(respond: (url: string, init?: RequestInit) => Response | Promise<Response>): {
  backend: HostFsMountBackend;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    return respond(url, init);
  }) as unknown as typeof fetch;
  return {
    backend: new HostFsMountBackend({ targetPath: '/mnt/kb', hostPath: '/h/kb', fetchImpl }),
    calls,
  };
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe('HostFsMountBackend', () => {
  it('routes rename through /api/hostfs/rename with mount + to params', async () => {
    const { backend, calls } = backendWith(() => ok({ ok: true }));
    await backend.rename('/a/old.txt', '/a/new.txt');
    expect(calls).toEqual([
      'POST /api/hostfs/rename?mount=%2Fmnt%2Fkb&path=a%2Fold.txt&to=a%2Fnew.txt',
    ]);
  });

  it('rethrows server errno JSON as a faithful FsError', async () => {
    const { backend } = backendWith(
      () => new Response(JSON.stringify({ code: 'ENOENT', message: 'gone' }), { status: 404 })
    );
    await expect(backend.stat('missing')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('surfaces an unreachable bridge as EIO, distinct from ENOENT', async () => {
    const { backend } = backendWith(() => {
      throw new Error('connection refused');
    });
    const err = await backend.readFile('x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FsError);
    expect((err as FsError).code).toBe('EIO');
  });

  it('parses list entries and drops malformed rows', async () => {
    const { backend } = backendWith(() =>
      ok({
        entries: [
          { name: 'a.txt', kind: 'file', size: 3, lastModified: 5 },
          { name: 'd', kind: 'directory' },
          { name: 1, kind: 'file' },
          { name: 'x', kind: 'weird' },
        ],
      })
    );
    await expect(backend.readDir('')).resolves.toEqual([
      { name: 'a.txt', kind: 'file', size: 3, lastModified: 5 },
      { name: 'd', kind: 'directory' },
    ]);
  });

  it('refuses all operations after close with EBADF', async () => {
    const { backend } = backendWith(() => ok({}));
    await backend.close();
    await expect(backend.readFile('x')).rejects.toMatchObject({ code: 'EBADF' });
  });
});
