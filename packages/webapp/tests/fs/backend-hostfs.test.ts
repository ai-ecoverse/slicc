import { describe, expect, it, vi } from 'vitest';

import { HostFsMountBackend } from '../../src/fs/mount/backend-hostfs.js';
import { FsError } from '../../src/fs/types.js';

function backendWith(respond: (url: string, init?: RequestInit) => Response | Promise<Response>): {
  backend: HostFsMountBackend;
  calls: string[];
  bodies: unknown[];
} {
  const calls: string[] = [];
  const bodies: unknown[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    bodies.push(typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body);
    return respond(url, init);
  }) as unknown as typeof fetch;
  return {
    backend: new HostFsMountBackend({ targetPath: '/mnt/kb', hostPath: '/h/kb', fetchImpl }),
    calls,
    bodies,
  };
}

/** What a bridge without the stable route answers: a code-less framework 404. */
const notFoundHtml = () => new Response('<html>Cannot POST /api/hostfs</html>', { status: 404 });

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe('HostFsMountBackend', () => {
  it('routes rename through the stable endpoint with mount + to in the body', async () => {
    const { backend, calls, bodies } = backendWith(() => ok({ ok: true }));
    await backend.rename('/a/old.txt', '/a/new.txt');
    expect(calls).toEqual(['POST /api/hostfs']);
    expect(bodies[0]).toEqual({
      op: 'rename',
      mount: '/mnt/kb',
      path: 'a/old.txt',
      to: 'a/new.txt',
    });
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

  // #2715: the CORS preflight cache is keyed by URL, so the metadata ops all
  // share one stable URL and only the body ops keep a per-path URL.
  it('sends every metadata op to the one stable URL', async () => {
    const { backend, calls, bodies } = backendWith(() => ok({ entries: [], kind: 'file' }));
    await backend.readDir('/deep/dir');
    await backend.stat('/deep/file.txt');
    await backend.mkdir('/deep/made');
    await backend.remove('/deep/made', { recursive: true });
    expect(new Set(calls)).toEqual(new Set(['POST /api/hostfs']));
    expect(bodies).toEqual([
      { op: 'list', mount: '/mnt/kb', path: 'deep/dir' },
      { op: 'stat', mount: '/mnt/kb', path: 'deep/file.txt' },
      { op: 'mkdir', mount: '/mnt/kb', path: 'deep/made' },
      { op: 'remove', mount: '/mnt/kb', path: 'deep/made', recursive: '1' },
    ]);
  });

  it('keeps read on a per-file GET and write on a per-file PUT', async () => {
    // A POST response is not cacheable; reads must stay GETs so the browser
    // can still revalidate a big blob with a 304, and writes carry raw bytes.
    const { backend, calls } = backendWith(() => new Response(new Uint8Array([1, 2]).buffer));
    await backend.readFile('/pack/big.pack');
    await backend.writeFile('/pack/idx', new Uint8Array([7]));
    expect(calls).toEqual([
      'GET /api/hostfs/read?mount=%2Fmnt%2Fkb&path=pack%2Fbig.pack',
      'PUT /api/hostfs/write?mount=%2Fmnt%2Fkb&path=pack%2Fidx',
    ]);
  });

  it('falls back to the per-op routes when the bridge has no stable endpoint', async () => {
    const { backend, calls } = backendWith((url) =>
      url.endsWith('/api/hostfs') ? notFoundHtml() : ok({ kind: 'file', size: 1, mtime: 2 })
    );
    await expect(backend.stat('/a.txt')).resolves.toEqual({ kind: 'file', size: 1, mtime: 2 });
    // Second op skips the doomed probe entirely — one wasted request total.
    await backend.stat('/b.txt');
    expect(calls).toEqual([
      'POST /api/hostfs',
      'GET /api/hostfs/stat?mount=%2Fmnt%2Fkb&path=a.txt',
      'GET /api/hostfs/stat?mount=%2Fmnt%2Fkb&path=b.txt',
    ]);
  });

  it('carries rename/remove params through to the fallback query string', async () => {
    const { backend, calls } = backendWith((url) =>
      url.endsWith('/api/hostfs') ? notFoundHtml() : ok({ ok: true })
    );
    await backend.rename('/a/old.txt', '/a/new.txt');
    await backend.remove('/a/dir', { recursive: true });
    expect(calls).toEqual([
      'POST /api/hostfs',
      'POST /api/hostfs/rename?mount=%2Fmnt%2Fkb&path=a%2Fold.txt&to=a%2Fnew.txt',
      'DELETE /api/hostfs/remove?mount=%2Fmnt%2Fkb&path=a%2Fdir&recursive=1',
    ]);
  });

  it('does not mistake a coded 404 from the stable endpoint for an absent route', async () => {
    // ENOENT on a real stable endpoint must stay ENOENT, not trigger a retry.
    const { backend, calls } = backendWith(
      () => new Response(JSON.stringify({ code: 'ENOENT', message: 'gone' }), { status: 404 })
    );
    await expect(backend.stat('missing')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(calls).toEqual(['POST /api/hostfs']);
  });

  it('refuses all operations after close with EBADF', async () => {
    const { backend } = backendWith(() => ok({}));
    await backend.close();
    await expect(backend.readFile('x')).rejects.toMatchObject({ code: 'EBADF' });
  });
});
