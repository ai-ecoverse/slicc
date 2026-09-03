import { describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

import { HostFsMountBackend, hostFsMountId } from '../../src/fs/mount/backend-hostfs.js';
import { RemoteMountCache } from '../../src/fs/mount/remote-cache.js';
import { FsError } from '../../src/fs/types.js';

function uniqueDbName(): string {
  return `hostfs-cache-${Math.random().toString(36).slice(2)}`;
}

function backendWith(
  respond: (url: string, init?: RequestInit) => Response | Promise<Response>,
  opts: {
    maxInflight?: number;
    maxAttempts?: number;
    cacheTtlMs?: number;
    maxCachedBodyBytes?: number;
  } = {}
): {
  backend: HostFsMountBackend;
  calls: string[];
  bodies: unknown[];
  headers: Record<string, string>[];
  caches: Array<RequestCache | undefined>;
} {
  const calls: string[] = [];
  const bodies: unknown[] = [];
  const headers: Record<string, string>[] = [];
  const caches: Array<RequestCache | undefined> = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    bodies.push(typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body);
    headers.push({ ...((init?.headers as Record<string, string> | undefined) ?? {}) });
    caches.push(init?.cache);
    return respond(url, init);
  }) as unknown as typeof fetch;
  return {
    backend: new HostFsMountBackend({
      targetPath: '/mnt/kb',
      hostPath: '/h/kb',
      fetchImpl,
      cache: new RemoteMountCache({
        mountId: 'test-hostfs',
        ttlMs: opts.cacheTtlMs ?? 30_000,
        dbName: uniqueDbName(),
      }),
      // Keep retry tests instant; production waits 25 ms then 50 ms.
      retryDelayMs: 0,
      ...opts,
    }),
    calls,
    bodies,
    headers,
    caches,
  };
}

/** What a bridge without the stable route answers: a code-less framework 404. */
const notFoundHtml = () => new Response('<html>Cannot POST /api/hostfs</html>', { status: 404 });

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

/** Yield a macrotask so pending fetch/JSON continuations can run. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * A 200 whose body read rejects — the bridge dropped the socket after the
 * headers were on the wire, which is the common shape for a large read.
 */
const bodyDrops = () =>
  ({
    ok: true,
    status: 200,
    json: () => Promise.reject(new TypeError('Failed to fetch')),
    arrayBuffer: () => Promise.reject(new TypeError('Failed to fetch')),
  }) as unknown as Response;

describe('HostFsMountBackend', () => {
  it('derives a stable mount id from the configured target and host paths', () => {
    const first = new HostFsMountBackend({
      targetPath: '/mnt/kb',
      hostPath: '/h/kb',
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    const second = new HostFsMountBackend({
      targetPath: '/mnt/kb',
      hostPath: '/h/kb',
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    expect(first.mountId).toBe(hostFsMountId('/mnt/kb', '/h/kb'));
    expect(second.mountId).toBe(first.mountId);
    expect(hostFsMountId('/mnt/other', '/h/kb')).not.toBe(first.mountId);
  });

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

  it('serves bodies from RemoteMountCache and fetches with cache:no-store', async () => {
    // Opaque browser HTTP cache is out of the coherence path; the app-owned
    // cache + hostfs_invalidate (and write-time putBody) keep bodies fresh.
    let reads = 0;
    const { backend, caches } = backendWith((url, init) => {
      if (String(url).includes('/write') || init?.method === 'PUT') {
        return new Response(null, { status: 200 });
      }
      reads += 1;
      return new Response(new Uint8Array([reads]).buffer, {
        headers: { etag: `"e${reads}"` },
      });
    });
    const first = await backend.readFile('/a.txt');
    const second = await backend.readFile('/a.txt');
    expect(first).toEqual(new Uint8Array([1]));
    expect(second).toEqual(new Uint8Array([1])); // IDB hit — no second network
    expect(reads).toBe(1);
    expect(caches[0]).toBe('no-store');

    await backend.writeFile('/a.txt', new Uint8Array([9]));
    const afterWrite = await backend.readFile('/a.txt');
    expect(afterWrite).toEqual(new Uint8Array([9])); // seeded on write
    expect(reads).toBe(1); // still no network read
  });

  it('drops cached bodies after recursive remove and host invalidation', async () => {
    let reads = 0;
    const { backend } = backendWith((url, init) => {
      if (
        init?.method === 'DELETE' ||
        String(url).includes('/remove') ||
        String(url).endsWith('/api/hostfs')
      ) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      reads += 1;
      return new Response(new Uint8Array([reads]).buffer, { headers: { etag: `"e${reads}"` } });
    });
    await backend.readFile('/dir/child.txt');
    expect(reads).toBe(1);
    await backend.remove('/dir', { recursive: true });
    await backend.readFile('/dir/child.txt');
    expect(reads).toBe(2);

    await backend.readFile('/other.txt');
    expect(reads).toBe(3);
    await backend.applyHostInvalidation(['other.txt']);
    await backend.readFile('/other.txt');
    expect(reads).toBe(4);
  });

  it('does not restore a body invalidated while its read is in flight', async () => {
    let releaseFetch!: () => void;
    const fetchReleased = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const { backend } = backendWith(async () => {
      await fetchReleased;
      return new Response(new Uint8Array([1]).buffer, { headers: { etag: '"old"' } });
    });

    const read = backend.readFile('/race.txt');
    await tick();
    await backend.applyHostInvalidation(['race.txt']);
    releaseFetch();

    await expect(read).resolves.toEqual(new Uint8Array([1]));
    await expect(backend.getCache().getBody('race.txt')).resolves.toBeNull();
  });

  it('invalidates cached descendants on both sides of a directory rename', async () => {
    const { backend } = backendWith(() => ok({ ok: true }));
    const cache = backend.getCache();
    await cache.putBody('old/child.txt', new Uint8Array([1]), '"old"');
    await cache.putBody('new/replaced.txt', new Uint8Array([2]), '"replaced"');

    await backend.rename('/old', '/new');

    await expect(cache.getBody('old/child.txt')).resolves.toBeNull();
    await expect(cache.getBody('new/replaced.txt')).resolves.toBeNull();
  });

  it('serves bodies over the cache size cap without memoizing them', async () => {
    const { backend } = backendWith(
      () => new Response(new Uint8Array([1, 2]).buffer, { headers: { etag: '"large"' } }),
      { maxCachedBodyBytes: 1 }
    );

    await expect(backend.readFile('/large.pack')).resolves.toEqual(new Uint8Array([1, 2]));
    await expect(backend.getCache().getBody('large.pack')).resolves.toBeNull();
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

  describe('transient network failures (#2720)', () => {
    it('retries an idempotent read past a single fetch rejection', async () => {
      let attempts = 0;
      const { backend, calls } = backendWith(() => {
        attempts += 1;
        if (attempts === 1) throw new TypeError('Failed to fetch');
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      });
      await expect(backend.readFile('a.txt')).resolves.toEqual(new Uint8Array([1, 2, 3]));
      expect(calls).toHaveLength(2);
    });

    it.each([
      ['stat', (b: HostFsMountBackend) => b.stat('a.txt')],
      ['list', (b: HostFsMountBackend) => b.readDir('sub')],
      ['mkdir', (b: HostFsMountBackend) => b.mkdir('sub')],
    ])('retries %s once and succeeds', async (_op, invoke) => {
      let attempts = 0;
      const { backend, calls } = backendWith(() => {
        attempts += 1;
        if (attempts === 1) throw new TypeError('Failed to fetch');
        return ok({ kind: 'file', size: 1, mtime: 2, entries: [] });
      });
      await expect(invoke(backend)).resolves.not.toThrow();
      expect(calls).toHaveLength(2);
    });

    it('gives up after maxAttempts with an EIO that names the op as transient', async () => {
      const { backend, calls } = backendWith(() => {
        throw new TypeError('Failed to fetch');
      });
      const err = await backend.stat('a.txt').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FsError);
      expect((err as FsError).code).toBe('EIO');
      expect((err as FsError).message).toContain('hostfs stat failed after 3 attempts');
      expect((err as FsError).message).toContain('transient bridge error: Failed to fetch');
      expect(calls).toHaveLength(3);
    });

    it('never replays a non-idempotent op, and says so', async () => {
      const { backend, calls } = backendWith(() => {
        throw new TypeError('Failed to fetch');
      });
      const err = await backend.writeFile('a.txt', new Uint8Array([1])).catch((e: unknown) => e);
      expect((err as FsError).code).toBe('EIO');
      expect((err as FsError).message).toContain(
        'hostfs write failed (not retried: non-idempotent'
      );
      expect(calls).toHaveLength(1);
    });

    it('does not retry HTTP errors — an errno answer is not a network failure', async () => {
      const { backend, calls } = backendWith(
        () => new Response(JSON.stringify({ code: 'ENOENT', message: 'gone' }), { status: 404 })
      );
      await expect(backend.stat('missing')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(calls).toHaveLength(1);
    });

    it('retries a body that drops mid-stream, then succeeds', async () => {
      let attempts = 0;
      const { backend, calls } = backendWith(() => {
        attempts += 1;
        if (attempts === 1) return bodyDrops();
        return new Response(new Uint8Array([7, 8]), { status: 200 });
      });
      // A large read that dies while streaming is a network failure like any
      // other — it used to escape as a raw TypeError, outside the retry loop.
      await expect(backend.readFile('big.bin')).resolves.toEqual(new Uint8Array([7, 8]));
      expect(calls).toHaveLength(2);
    });

    it('maps a body that never arrives to the transient EIO after maxAttempts', async () => {
      const { backend, calls } = backendWith(() => bodyDrops());
      const err = await backend.readDir('sub').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FsError);
      expect((err as FsError).code).toBe('EIO');
      expect((err as FsError).message).toContain('hostfs list failed after 3 attempts');
      expect((err as FsError).message).toContain('transient bridge error: Failed to fetch');
      expect(calls).toHaveLength(3);
    });

    it('does not retry a dropped body for a non-idempotent op', async () => {
      const { backend, calls } = backendWith(() => bodyDrops());
      const err = await backend.writeFile('a.txt', new Uint8Array([1])).catch((e: unknown) => e);
      expect((err as FsError).code).toBe('EIO');
      expect((err as FsError).message).toContain(
        'hostfs write failed (not retried: non-idempotent'
      );
      expect(calls).toHaveLength(1);
    });

    it('spends no retry attempt on the stable-endpoint downgrade', async () => {
      // The 404 that switches routes is a routing correction, not a transient
      // failure: all three network attempts must still be available after it.
      let perOpCalls = 0;
      const { backend, calls } = backendWith((url) => {
        if (url.endsWith('/api/hostfs')) return notFoundHtml();
        perOpCalls += 1;
        if (perOpCalls <= 2) throw new TypeError('Failed to fetch');
        return ok({ kind: 'file', size: 1, mtime: 2 });
      });
      await expect(backend.stat('/a.txt')).resolves.toEqual({ kind: 'file', size: 1, mtime: 2 });
      expect(calls).toEqual([
        'POST /api/hostfs',
        'GET /api/hostfs/stat?mount=%2Fmnt%2Fkb&path=a.txt',
        'GET /api/hostfs/stat?mount=%2Fmnt%2Fkb&path=a.txt',
        'GET /api/hostfs/stat?mount=%2Fmnt%2Fkb&path=a.txt',
      ]);
    });

    it('maps a fallback-route network failure through the same transient EIO', async () => {
      const { backend, calls } = backendWith((url) => {
        if (url.endsWith('/api/hostfs')) return notFoundHtml();
        throw new TypeError('Failed to fetch');
      });
      const err = await backend.stat('/a.txt').catch((e: unknown) => e);
      expect((err as FsError).code).toBe('EIO');
      expect((err as FsError).message).toContain('hostfs stat failed after 3 attempts');
      // One downgrade probe plus the three real attempts.
      expect(calls).toHaveLength(4);
    });

    it('holds the limiter slot until the body is consumed', async () => {
      const releases: Array<() => void> = [];
      const { backend, calls } = backendWith(
        () =>
          ({
            ok: true,
            status: 200,
            json: () =>
              new Promise((resolve) => {
                releases.push(() => resolve({ kind: 'file', size: 0, mtime: 0 }));
              }),
          }) as unknown as Response,
        { maxInflight: 1 }
      );

      const first = backend.stat('a.txt');
      const second = backend.stat('b.txt');
      await tick();
      // The second request must NOT have been issued: the first still owns the
      // only slot because its body is still streaming.
      expect(calls).toHaveLength(1);
      expect(releases).toHaveLength(1);

      releases.shift()?.();
      await first;
      await tick();
      expect(calls).toHaveLength(2);
      releases.shift()?.();
      await expect(second).resolves.toMatchObject({ kind: 'file' });
    });

    it('caps concurrent bridge requests at maxInflight', async () => {
      let concurrent = 0;
      let peak = 0;
      const release: Array<() => void> = [];
      const { backend } = backendWith(
        async () => {
          concurrent += 1;
          peak = Math.max(peak, concurrent);
          await new Promise<void>((resolve) => release.push(resolve));
          concurrent -= 1;
          return ok({ kind: 'file', size: 0, mtime: 0 });
        },
        { maxInflight: 2 }
      );

      const pending = Array.from({ length: 8 }, (_, i) => backend.stat(`f${i}.txt`));
      await tick();
      // Six of the eight are queued behind the limiter, not in the socket pool.
      expect(release).toHaveLength(2);

      for (let i = 0; i < 20 && release.length > 0; i += 1) {
        release.shift()?.();
        await tick();
      }
      await Promise.all(pending);
      expect(peak).toBe(2);
    });
  });

  it('carries the stat identity fields git needs through stat()', async () => {
    // ctime/ino/uid/gid/mode are what isomorphic-git's compareStats needs to
    // decide a file still matches its index entry (issue #2708). Served
    // identically by the stable POST dispatcher and the per-op GET route.
    const { backend } = backendWith(() =>
      ok({
        kind: 'file',
        size: 7,
        mtime: 1000,
        ctime: 1200,
        ino: 42,
        uid: 501,
        gid: 20,
        mode: 33261,
      })
    );
    await expect(backend.stat('a.txt')).resolves.toEqual({
      kind: 'file',
      size: 7,
      mtime: 1000,
      ctime: 1200,
      ino: 42,
      uid: 501,
      gid: 20,
      mode: 33261,
    });
  });

  it('omits identity fields an older bridge does not send', async () => {
    const { backend } = backendWith(() => ok({ kind: 'file', size: 7, mtime: 1000 }));
    await expect(backend.stat('a.txt')).resolves.toEqual({ kind: 'file', size: 7, mtime: 1000 });
  });

  it('ignores non-numeric identity fields rather than failing the stat', async () => {
    const { backend } = backendWith(() =>
      ok({ kind: 'file', size: 7, mtime: 1000, ino: 'nope', mode: null, uid: Number.NaN, gid: 20 })
    );
    await expect(backend.stat('a.txt')).resolves.toEqual({
      kind: 'file',
      size: 7,
      mtime: 1000,
      gid: 20,
    });
  });

  it('carries the stat identity on list entries too', async () => {
    const { backend } = backendWith(() =>
      ok({
        entries: [
          { name: 'a.txt', kind: 'file', size: 3, lastModified: 5, ino: 9, mode: 33188 },
          { name: 'd', kind: 'directory' },
        ],
      })
    );
    await expect(backend.readDir('')).resolves.toEqual([
      { name: 'a.txt', kind: 'file', size: 3, lastModified: 5, ino: 9, mode: 33188 },
      { name: 'd', kind: 'directory' },
    ]);
  });

  it('refuses all operations after close with EBADF', async () => {
    const { backend } = backendWith(() => ok({}));
    await backend.close();
    await expect(backend.readFile('x')).rejects.toMatchObject({ code: 'EBADF' });
  });
});

/**
 * Ranged reads are how git reaches a packfile that does not fit under the
 * whole-file body cap, and how a pack that does fit stops costing its full
 * size in worker memory per object lookup (issue #2711).
 */
describe('HostFsMountBackend.readFileRange', () => {
  /** A 206 carrying exactly the requested window of `whole`. */
  const partial = (whole: Uint8Array) => (_url: string, init?: RequestInit) => {
    const range = (init?.headers as Record<string, string> | undefined)?.Range ?? '';
    const [, from, to] = /^bytes=(\d+)-(\d+)$/.exec(range) ?? [];
    const slice = whole.slice(Number(from), Number(to) + 1);
    return new Response(slice, {
      status: 206,
      headers: { 'Content-Range': `bytes ${from}-${to}/${whole.byteLength}` },
    });
  };

  const pack = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

  it('asks for the inclusive wire range of a half-open window', async () => {
    const { backend, calls, headers } = backendWith(partial(pack));
    await expect(backend.readFileRange('objects/pack/p.pack', 4, 8)).resolves.toEqual(
      new Uint8Array([4, 5, 6, 7])
    );
    // Per-file GET, never the stable POST — the browser cache keys on the URL.
    expect(calls).toEqual(['GET /api/hostfs/read?mount=%2Fmnt%2Fkb&path=objects%2Fpack%2Fp.pack']);
    expect(headers[0].Range).toBe('bytes=4-7');
  });

  it('never asks for the whole body — the window is the only transfer', async () => {
    let served = 0;
    const { backend, headers } = backendWith((_url, init) => {
      served += 1;
      return partial(pack)(_url, init);
    });
    await backend.readFileRange('big.pack', 9, 10);
    expect(served).toBe(1);
    expect(headers[0].Range).toBe('bytes=9-9');
  });

  it('slices client-side when a bridge without Range answers 200 with everything', async () => {
    const { backend } = backendWith(() => new Response(pack, { status: 200 }));
    await expect(backend.readFileRange('p.pack', 2, 5)).resolves.toEqual(new Uint8Array([2, 3, 4]));
  });

  it('returns empty for a zero-length window without touching the bridge', async () => {
    const { backend, calls } = backendWith(() => new Response(pack, { status: 206 }));
    await expect(backend.readFileRange('p.pack', 3, 3)).resolves.toEqual(new Uint8Array(0));
    expect(calls).toEqual([]);
  });

  it('rejects a descending or fractional window with EINVAL', async () => {
    const { backend, calls } = backendWith(() => new Response(pack, { status: 206 }));
    await expect(backend.readFileRange('p.pack', 8, 2)).rejects.toMatchObject({ code: 'EINVAL' });
    await expect(backend.readFileRange('p.pack', -1, 4)).rejects.toMatchObject({ code: 'EINVAL' });
    await expect(backend.readFileRange('p.pack', 0, 1.5)).rejects.toMatchObject({ code: 'EINVAL' });
    expect(calls).toEqual([]);
  });

  it('caps the WINDOW, not the file — a 100 MB+ pack stays reachable', async () => {
    const cap = 100 * 1024 * 1024;
    const { backend, headers } = backendWith(
      () => new Response(new Uint8Array(4), { status: 206 })
    );
    // A window past the cap is refused …
    await expect(backend.readFileRange('p.pack', 0, cap + 1)).rejects.toMatchObject({
      code: 'EFBIG',
    });
    // … but an offset far beyond it is not: that is the whole point.
    await backend.readFileRange('p.pack', 512 * 1024 * 1024, 512 * 1024 * 1024 + 4);
    expect(headers[0].Range).toBe('bytes=536870912-536870915');
  });

  it('rethrows the bridge 416 as a faithful EINVAL', async () => {
    const { backend } = backendWith(
      () =>
        new Response(JSON.stringify({ code: 'EINVAL', message: 'range not satisfiable' }), {
          status: 416,
        })
    );
    await expect(backend.readFileRange('p.pack', 0, 4)).rejects.toMatchObject({ code: 'EINVAL' });
  });

  it('refuses a ranged read after close with EBADF', async () => {
    const { backend } = backendWith(() => new Response(pack, { status: 206 }));
    await backend.close();
    await expect(backend.readFileRange('p.pack', 0, 4)).rejects.toMatchObject({ code: 'EBADF' });
  });
});
