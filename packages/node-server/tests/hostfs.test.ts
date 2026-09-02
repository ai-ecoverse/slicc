import express from 'express';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { shouldParseGlobalJson } from '../src/fetch-proxy-headers.js';
import {
  HOSTFS_STABLE_MAX_BODY_BYTES,
  isHostFsStableBodyRequest,
  parseByteRange,
  registerHostFsRoutes,
  resolveHostMountRoots,
  resolveWithinRoot,
} from '../src/hostfs.js';

interface StatIdentity {
  ctime?: number;
  ino?: number;
  uid?: number;
  gid?: number;
  mode?: number;
}

let root: string;
let outside: string;
let baseUrl: string;
let close: () => Promise<void>;

async function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl}${path}`, init);
}

/** One call to the stable, preflight-cacheable `POST /api/hostfs` endpoint. */
async function stable(body: Record<string, unknown>): Promise<Response> {
  return api('/api/hostfs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'slicc-hostfs-')));
  outside = await realpath(await mkdtemp(join(tmpdir(), 'slicc-hostfs-outside-')));
  await mkdir(join(root, 'sub'));
  await writeFile(join(root, 'hello.txt'), 'hello host');
  await writeFile(join(outside, 'secret.txt'), 'nope');
  await symlink(outside, join(root, 'escape-link'));
  await symlink(join(root, 'sub'), join(root, 'inside-link'));

  const app = express();
  const roots = await resolveHostMountRoots(
    [
      { hostPath: root, path: '/mnt/proj' },
      { hostPath: join(root, 'does-not-exist'), path: '/mnt/gone' },
    ],
    () => {}
  );
  expect(roots).toEqual([{ path: '/mnt/proj', root }]);
  registerHostFsRoutes(app, roots);
  const listening = app.listen(0);
  const port = (listening.address() as { port: number }).port;
  baseUrl = `http://127.0.0.1:${port}`;
  close = () =>
    new Promise<void>((r) => {
      // See the note in cloud-status.test.ts: a pooled keep-alive socket plus a
      // recycled ephemeral port crosses one test's client onto another's server.
      listening.closeAllConnections?.();
      listening.close(() => r());
    });
});

afterAll(async () => {
  await close();
});

describe('hostfs routes', () => {
  it('lists a directory with file sizes', async () => {
    const res = await api('/api/hostfs/list?mount=%2Fmnt%2Fproj&path=');
    expect(res.status).toBe(200);
    const { entries } = (await res.json()) as { entries: { name: string; kind: string }[] };
    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual(['escape-link', 'hello.txt', 'inside-link', 'sub']);
    const hello = entries.find((e) => e.name === 'hello.txt') as { size?: number };
    expect(hello.size).toBe(10);
    // A symlink to a directory classifies as a directory (stat-following),
    // matching what any subsequent access sees.
    expect(entries.find((e) => e.name === 'inside-link')?.kind).toBe('directory');
  });

  it('stats and reads a file', async () => {
    const statRes = await api('/api/hostfs/stat?mount=%2Fmnt%2Fproj&path=hello.txt');
    expect(((await statRes.json()) as { kind: string }).kind).toBe('file');
    const readRes = await api('/api/hostfs/read?mount=%2Fmnt%2Fproj&path=hello.txt');
    expect(await readRes.text()).toBe('hello host');
  });

  it('reports the stat identity git needs (ctime, ino, uid, gid, mode)', async () => {
    // Without these isomorphic-git's compareStats is stale for every file, so
    // a read-only command re-hashes the tree and rewrites .git/index once per
    // file — issue #2708.
    const res = await api('/api/hostfs/stat?mount=%2Fmnt%2Fproj&path=hello.txt');
    const body = (await res.json()) as StatIdentity;
    const real = await stat(join(root, 'hello.txt'));
    expect(body.ctime).toBe(real.ctimeMs);
    expect(body.ino).toBe(Number(real.ino));
    expect(body.uid).toBe(real.uid);
    expect(body.gid).toBe(real.gid);
    // Full st_mode, type bits included — so the executable bit survives.
    expect(body.mode).toBe(real.mode);
  });

  it('preserves the executable bit in the reported mode', async () => {
    await chmod(join(root, 'hello.txt'), 0o755);
    try {
      const res = await api('/api/hostfs/stat?mount=%2Fmnt%2Fproj&path=hello.txt');
      const body = (await res.json()) as { mode?: number };
      expect((body.mode ?? 0) & 0o777).toBe(0o755);
    } finally {
      await chmod(join(root, 'hello.txt'), 0o644);
    }
  });

  it('carries the stat identity on list entries too', async () => {
    const res = await api('/api/hostfs/list?mount=%2Fmnt%2Fproj&path=');
    const { entries } = (await res.json()) as { entries: ({ name: string } & StatIdentity)[] };
    const hello = entries.find((e) => e.name === 'hello.txt');
    const real = await stat(join(root, 'hello.txt'));
    expect(hello?.ino).toBe(Number(real.ino));
    expect(hello?.uid).toBe(real.uid);
    expect(hello?.gid).toBe(real.gid);
    expect(hello?.mode).toBe(real.mode);
    expect(hello?.ctime).toBe(real.ctimeMs);
  });

  it('never rounds a timestamp up into the next second', async () => {
    // isomorphic-git compares Math.floor(ms / 1000) against the seconds
    // native git recorded, so a stat 0.9996 s past the second that is ROUNDED
    // lands in the next second and leaves that file stale on every walk.
    const racy = join(root, 'racy.txt');
    await writeFile(racy, 'x');
    await utimes(racy, 1_700_000_000.9996, 1_700_000_000.9996);
    const real = await stat(racy);

    const res = await api('/api/hostfs/stat?mount=%2Fmnt%2Fproj&path=racy.txt');
    const body = (await res.json()) as StatIdentity & { mtime?: number };
    expect(body.mtime).toBe(real.mtimeMs);
    expect(body.ctime).toBe(real.ctimeMs);
    expect(Math.floor((body.mtime ?? 0) / 1000)).toBe(1_700_000_000);
    expect(Math.floor((body.ctime ?? 0) / 1000)).toBe(Math.floor(real.ctimeMs / 1000));

    const listRes = await api('/api/hostfs/list?mount=%2Fmnt%2Fproj&path=');
    const { entries } = (await listRes.json()) as {
      entries: ({ name: string; lastModified?: number } & StatIdentity)[];
    };
    const racyEntry = entries.find((e) => e.name === 'racy.txt');
    expect(racyEntry?.lastModified).toBe(real.mtimeMs);
    expect(Math.floor((racyEntry?.lastModified ?? 0) / 1000)).toBe(1_700_000_000);
    expect(racyEntry?.ctime).toBe(real.ctimeMs);
  });

  it('writes a file, creating parents', async () => {
    const res = await api('/api/hostfs/write?mount=%2Fmnt%2Fproj&path=new/deep/file.txt', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: 'written from test',
    });
    expect(res.status).toBe(200);
    expect(await readFile(join(root, 'new/deep/file.txt'), 'utf8')).toBe('written from test');
  });

  it('mkdir, rename, and remove work and refuse the mount root', async () => {
    expect(
      (await api('/api/hostfs/mkdir?mount=%2Fmnt%2Fproj&path=made', { method: 'POST' })).status
    ).toBe(200);
    expect(
      (
        await api('/api/hostfs/rename?mount=%2Fmnt%2Fproj&path=made&to=renamed', {
          method: 'POST',
        })
      ).status
    ).toBe(200);
    expect(
      (
        await api('/api/hostfs/remove?mount=%2Fmnt%2Fproj&path=renamed&recursive=1', {
          method: 'DELETE',
        })
      ).status
    ).toBe(200);
    const rootRm = await api('/api/hostfs/remove?mount=%2Fmnt%2Fproj&path=&recursive=1', {
      method: 'DELETE',
    });
    expect(rootRm.status).toBe(403);
  });

  it('maps errno to status + FsError code', async () => {
    const missing = await api('/api/hostfs/read?mount=%2Fmnt%2Fproj&path=missing.txt');
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { code: string }).code).toBe('ENOENT');
    const dirRead = await api('/api/hostfs/read?mount=%2Fmnt%2Fproj&path=sub');
    expect(dirRead.status).toBe(409);
    expect(((await dirRead.json()) as { code: string }).code).toBe('EISDIR');
    const noMount = await api('/api/hostfs/list?mount=%2Fmnt%2Fnope&path=');
    expect(noMount.status).toBe(404);
  });

  it('rejects traversal and symlink escapes with EACCES', async () => {
    const dotdot = await api('/api/hostfs/read?mount=%2Fmnt%2Fproj&path=..%2Fsecret.txt');
    expect(dotdot.status).toBe(403);
    const viaLink = await api('/api/hostfs/read?mount=%2Fmnt%2Fproj&path=escape-link%2Fsecret.txt');
    expect(viaLink.status).toBe(403);
    // Symlinks that stay inside the root are followed.
    const inside = await api('/api/hostfs/list?mount=%2Fmnt%2Fproj&path=inside-link');
    expect(inside.status).toBe(200);
  });
});

describe('stable POST /api/hostfs endpoint', () => {
  // One URL for every metadata op is the whole point: the CORS preflight
  // cache is keyed by URL, so the per-op `?mount=&path=` routes never got a
  // cache hit (#2715). These assert the stable route answers identically.
  it('lists a directory with the same payload as GET /list', async () => {
    const viaPost = await stable({ op: 'list', mount: '/mnt/proj', path: '' });
    expect(viaPost.status).toBe(200);
    const viaGet = await api('/api/hostfs/list?mount=%2Fmnt%2Fproj&path=');
    expect(await viaPost.json()).toEqual(await viaGet.json());
  });

  it('stats a file with the same payload as GET /stat', async () => {
    const viaPost = await stable({ op: 'stat', mount: '/mnt/proj', path: 'hello.txt' });
    expect(viaPost.status).toBe(200);
    const body = (await viaPost.json()) as { kind: string; size: number };
    expect(body.kind).toBe('file');
    expect(body.size).toBe(10);
  });

  it('carries the stat identity through the stable endpoint too', async () => {
    // The dispatcher shares listOp/statOp with the per-op routes, so the
    // enriched payload must not depend on which transport a caller picked —
    // a webapp on the stable endpoint still needs ctime/ino/uid/gid/mode or
    // every read-only git command re-hashes the tree (#2708).
    const viaPost = await stable({ op: 'stat', mount: '/mnt/proj', path: 'hello.txt' });
    const body = (await viaPost.json()) as StatIdentity;
    const real = await stat(join(root, 'hello.txt'));
    expect(body.ctime).toBe(real.ctimeMs);
    expect(body.ino).toBe(Number(real.ino));
    expect(body.uid).toBe(real.uid);
    expect(body.gid).toBe(real.gid);
    expect(body.mode).toBe(real.mode);

    const listPost = await stable({ op: 'list', mount: '/mnt/proj', path: '' });
    const { entries } = (await listPost.json()) as {
      entries: ({ name: string } & StatIdentity)[];
    };
    const hello = entries.find((e) => e.name === 'hello.txt');
    expect(hello?.ino).toBe(Number(real.ino));
    expect(hello?.mode).toBe(real.mode);
  });

  it('mkdirs, renames, and removes through the one URL', async () => {
    expect((await stable({ op: 'mkdir', mount: '/mnt/proj', path: 'post/made' })).status).toBe(200);
    expect(
      (await stable({ op: 'rename', mount: '/mnt/proj', path: 'post/made', to: 'post/renamed' }))
        .status
    ).toBe(200);
    // `recursive` accepts the query-string `'1'` and a JSON `true` alike.
    expect(
      (await stable({ op: 'remove', mount: '/mnt/proj', path: 'post/renamed', recursive: true }))
        .status
    ).toBe(200);
    expect(
      (await stable({ op: 'remove', mount: '/mnt/proj', path: 'post', recursive: '1' })).status
    ).toBe(200);
  });

  it('refuses to remove a mount root', async () => {
    const res = await stable({ op: 'remove', mount: '/mnt/proj', path: '', recursive: true });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('EACCES');
  });

  it('maps errno, traversal, and unknown mounts to coded JSON', async () => {
    const missing = await stable({ op: 'stat', mount: '/mnt/proj', path: 'missing.txt' });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { code: string }).code).toBe('ENOENT');

    const escape = await stable({ op: 'stat', mount: '/mnt/proj', path: '../secret.txt' });
    expect(escape.status).toBe(403);
    expect(((await escape.json()) as { code: string }).code).toBe('EACCES');

    const noMount = await stable({ op: 'list', mount: '/mnt/nope', path: '' });
    expect(noMount.status).toBe(404);
    expect(((await noMount.json()) as { code: string }).code).toBe('ENOENT');
  });

  it('rejects unknown ops and a rename without `to` with a coded 400', async () => {
    // Every error MUST carry a `code` — a code-less 404/405 is exactly the
    // signal `HostFsMountBackend` uses to decide the bridge has no stable
    // endpoint and downgrade to the per-op routes.
    const unknown = await stable({ op: 'read', mount: '/mnt/proj', path: 'hello.txt' });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { code: string }).code).toBe('EINVAL');

    const noTo = await stable({ op: 'rename', mount: '/mnt/proj', path: 'hello.txt' });
    expect(noTo.status).toBe(400);
    expect(((await noTo.json()) as { code: string }).code).toBe('EINVAL');
  });

  it('does not shadow the per-op POST routes', async () => {
    const res = await api('/api/hostfs/mkdir?mount=%2Fmnt%2Fproj&path=still-per-op', {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect((await api('/api/hostfs/stat?mount=%2Fmnt%2Fproj&path=still-per-op')).status).toBe(200);
  });
});

/**
 * The stable dispatcher's `{ code, message }` contract has to survive the
 * REAL middleware order: `index.ts` mounts a 50 MiB global `express.json()`
 * BEFORE `registerHostFsRoutes`. Without the `shouldParseGlobalJson`
 * exclusion the global parser eats the body first — the route-local 1 MiB cap
 * never applies, and a malformed body reaches express's default handler,
 * which answers code-less HTML the webapp cannot turn into an `FsError`.
 */
describe('stable endpoint under the production middleware order', () => {
  let prodBase: string;
  let prodClose: () => Promise<void>;

  beforeAll(async () => {
    const app = express();
    // Mirror index.ts exactly: global parser first, same predicate. (The
    // predicate lives in fetch-proxy-headers.ts because importing index.ts
    // would run its module-load `main()` and boot a real server.)
    app.use(express.json({ limit: '50mb', type: shouldParseGlobalJson }));
    app.post('/api/echo', (req, res) => {
      res.json({ body: req.body });
    });
    registerHostFsRoutes(
      app,
      await resolveHostMountRoots([{ hostPath: root, path: '/mnt/proj' }], () => {})
    );
    const listening = app.listen(0);
    prodBase = `http://127.0.0.1:${(listening.address() as { port: number }).port}`;
    prodClose = () =>
      new Promise<void>((r) => {
        listening.closeAllConnections?.();
        listening.close(() => r());
      });
  });

  afterAll(async () => {
    await prodClose();
  });

  const post = (body: string): Promise<Response> =>
    fetch(`${prodBase}/api/hostfs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

  it('answers malformed JSON with a coded 400, not code-less HTML', async () => {
    const res = await post('{not json');
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect((await res.json()) as { code: string }).toMatchObject({ code: 'EINVAL' });
  });

  it('answers an oversized body with a coded 413 at the 1 MiB route cap', async () => {
    // Well over the route-local cap but far under the global 50 MiB one, so
    // this only rejects if the exclusion really handed the body to the
    // bounded parser. Regression guard for the exact bug.
    const oversized = JSON.stringify({
      op: 'stat',
      mount: '/mnt/proj',
      path: 'x'.repeat(HOSTFS_STABLE_MAX_BODY_BYTES + 1024),
    });
    expect(oversized.length).toBeLessThan(50 * 1024 * 1024);
    const res = await post(oversized);
    expect(res.status).toBe(413);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect((await res.json()) as { code: string }).toMatchObject({ code: 'EFBIG' });
  });

  it('still serves a well-formed body through the same pipeline', async () => {
    const res = await post(JSON.stringify({ op: 'stat', mount: '/mnt/proj', path: 'hello.txt' }));
    expect(res.status).toBe(200);
    expect((await res.json()) as { kind: string }).toMatchObject({ kind: 'file', size: 10 });
  });

  it('leaves the global parser in charge of every other JSON route', async () => {
    const res = await fetch(`${prodBase}/api/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });
    expect((await res.json()) as { body: unknown }).toEqual({ body: { hello: 'world' } });
  });
});

/**
 * `Range` support on `read` is what makes a repo whose largest packfile
 * exceeds the whole-file cap reachable by git at all, and it keeps the bridge
 * from buffering a 92 MB pack per object lookup (issue #2711).
 */
describe('hostfs read: byte ranges', () => {
  const readWithRange = (range: string): Promise<Response> =>
    api('/api/hostfs/read?mount=%2Fmnt%2Fproj&path=hello.txt', { headers: { Range: range } });

  it('answers a window with 206, Content-Range and only those bytes', async () => {
    const res = await readWithRange('bytes=6-9');
    expect(res.status).toBe(206);
    // "hello host" → bytes 6..9 are "host".
    expect(await res.text()).toBe('host');
    expect(res.headers.get('content-range')).toBe('bytes 6-9/10');
    expect(res.headers.get('content-length')).toBe('4');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
  });

  it('runs an open-ended range to EOF and clamps an end past it', async () => {
    expect(await (await readWithRange('bytes=6-')).text()).toBe('host');
    const clamped = await readWithRange('bytes=6-9999');
    expect(clamped.status).toBe(206);
    expect(clamped.headers.get('content-range')).toBe('bytes 6-9/10');
    expect(await clamped.text()).toBe('host');
  });

  it('serves the suffix form as the last N bytes', async () => {
    const res = await readWithRange('bytes=-4');
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 6-9/10');
    expect(await res.text()).toBe('host');
  });

  it('rejects a range outside the file with 416 + Content-Range', async () => {
    const res = await readWithRange('bytes=99-120');
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe('bytes */10');
    expect((await res.json()) as { code: string }).toMatchObject({ code: 'EINVAL' });
  });

  it('ignores an unparseable Range and serves the whole file', async () => {
    // RFC 9110 §14.2: a Range a recipient cannot make sense of is ignored.
    const res = await readWithRange('items=0-2');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello host');
    // Still advertised, so a client knows it can retry with a real range.
    expect(res.headers.get('accept-ranges')).toBe('bytes');
  });

  it('advertises Accept-Ranges and a Content-Length on an unranged read', async () => {
    const res = await api('/api/hostfs/read?mount=%2Fmnt%2Fproj&path=hello.txt');
    expect(res.status).toBe(200);
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-length')).toBe('10');
    expect(await res.text()).toBe('hello host');
  });

  it('keeps errno answers for a missing file and a directory', async () => {
    const missing = await api('/api/hostfs/read?mount=%2Fmnt%2Fproj&path=missing.txt', {
      headers: { Range: 'bytes=0-1' },
    });
    expect(missing.status).toBe(404);
    expect((await missing.json()) as { code: string }).toMatchObject({ code: 'ENOENT' });
    const dir = await api('/api/hostfs/read?mount=%2Fmnt%2Fproj&path=sub', {
      headers: { Range: 'bytes=0-1' },
    });
    expect(dir.status).toBe(409);
    expect((await dir.json()) as { code: string }).toMatchObject({ code: 'EISDIR' });
  });
});

/**
 * Streaming the body cost us the ETag express derived from the buffered one.
 * Without a replacement the browser cannot revalidate a pack URL, so it
 * re-transfers 92 MB on every object lookup — in the #2707 baseline 220,310 of
 * 385,033 hostfs GETs were 304s, so this is the difference the route lives on.
 */
describe('hostfs read: conditional requests', () => {
  const readWith = (headers: Record<string, string>): Promise<Response> =>
    api('/api/hostfs/read?mount=%2Fmnt%2Fproj&path=hello.txt', { headers });

  async function currentValidators(): Promise<{ etag: string; lastModified: string }> {
    const res = await api('/api/hostfs/read?mount=%2Fmnt%2Fproj&path=hello.txt');
    const etag = res.headers.get('etag');
    const lastModified = res.headers.get('last-modified');
    expect(etag).toBeTruthy();
    expect(lastModified).toBeTruthy();
    return { etag: etag as string, lastModified: lastModified as string };
  }

  it('serves an ETag and Last-Modified on the whole-file and ranged branches', async () => {
    const { etag } = await currentValidators();
    // A strong tag — If-Range is only defined for one.
    expect(etag.startsWith('W/')).toBe(false);
    const ranged = await readWith({ Range: 'bytes=0-3' });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('etag')).toBe(etag);
    expect(ranged.headers.get('last-modified')).toBeTruthy();
  });

  it('answers a repeat GET carrying the ETag with 304 and no body', async () => {
    const { etag } = await currentValidators();
    const res = await readWith({ 'If-None-Match': etag });
    expect(res.status).toBe(304);
    expect(await res.text()).toBe('');
    // The validators ride along so the client can refresh its stored metadata.
    expect(res.headers.get('etag')).toBe(etag);
    expect(res.headers.get('accept-ranges')).toBe('bytes');
  });

  it('matches a weak form of the tag and a bare *', async () => {
    const { etag } = await currentValidators();
    expect((await readWith({ 'If-None-Match': `W/${etag}` })).status).toBe(304);
    expect((await readWith({ 'If-None-Match': `"other", ${etag}` })).status).toBe(304);
    expect((await readWith({ 'If-None-Match': '*' })).status).toBe(304);
    expect((await readWith({ 'If-None-Match': '"stale"' })).status).toBe(200);
  });

  it('revalidates with If-Modified-Since and serves 200 once mtime moves', async () => {
    const { lastModified } = await currentValidators();
    expect((await readWith({ 'If-Modified-Since': lastModified })).status).toBe(304);

    const moved = new Date(Date.now() + 60_000);
    await utimes(join(root, 'hello.txt'), moved, moved);
    try {
      const res = await readWith({ 'If-Modified-Since': lastModified });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('hello host');
      // A changed mtime is a changed ETag, so the old one no longer matches.
      const stale = await readWith({ 'If-None-Match': (await currentValidators()).etag });
      expect(stale.status).toBe(304);
    } finally {
      const back = new Date(Date.now() - 60_000);
      await utimes(join(root, 'hello.txt'), back, back);
    }
  });

  it('ignores an unparseable If-Modified-Since instead of guessing', async () => {
    expect((await readWith({ 'If-Modified-Since': 'yesterday-ish' })).status).toBe(200);
  });

  it('honors a Range when If-Range still matches', async () => {
    const { etag } = await currentValidators();
    const res = await readWith({ Range: 'bytes=6-9', 'If-Range': etag });
    expect(res.status).toBe(206);
    expect(await res.text()).toBe('host');
  });

  it('downgrades a Range to the full 200 when If-Range does not match', async () => {
    // The client holds a DIFFERENT representation; stitching a window of the
    // current file into that buffer would silently corrupt it.
    const res = await readWith({ Range: 'bytes=6-9', 'If-Range': '"not-the-current-tag"' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello host');
    expect(res.headers.get('content-range')).toBeNull();
  });

  it('accepts the HTTP-date form of If-Range and rejects a stale one', async () => {
    const { lastModified } = await currentValidators();
    expect((await readWith({ Range: 'bytes=6-9', 'If-Range': lastModified })).status).toBe(206);
    const older = new Date(Date.parse(lastModified) - 60_000).toUTCString();
    expect((await readWith({ Range: 'bytes=6-9', 'If-Range': older })).status).toBe(200);
  });

  it('does not let a stale If-Range turn an out-of-range window into a 416', async () => {
    // The Range is dropped entirely, so the file is served whole — a 416 here
    // would be a bogus error for a client that just has an old copy.
    const res = await readWith({ Range: 'bytes=900-999', 'If-Range': '"stale"' });
    expect(res.status).toBe(200);
  });
});

describe('parseByteRange', () => {
  it('returns the inclusive window for the three well-formed shapes', () => {
    expect(parseByteRange('bytes=0-9', 100)).toEqual({ kind: 'range', start: 0, end: 9 });
    expect(parseByteRange('bytes=90-', 100)).toEqual({ kind: 'range', start: 90, end: 99 });
    expect(parseByteRange('bytes=-10', 100)).toEqual({ kind: 'range', start: 90, end: 99 });
    // A suffix longer than the file is the whole file, not an error.
    expect(parseByteRange('bytes=-500', 100)).toEqual({ kind: 'range', start: 0, end: 99 });
    expect(parseByteRange(' bytes=0-0 ', 100)).toEqual({ kind: 'range', start: 0, end: 0 });
  });

  it('ignores anything it cannot make sense of', () => {
    for (const header of [undefined, '', 'bytes=', 'items=0-1', 'bytes=0-1, 5-6', 'bytes=a-b']) {
      expect(parseByteRange(header, 100)).toEqual({ kind: 'none' });
    }
  });

  it('reports a well-formed range outside the file as unsatisfiable', () => {
    expect(parseByteRange('bytes=100-200', 100)).toEqual({ kind: 'unsatisfiable' });
    expect(parseByteRange('bytes=-0', 100)).toEqual({ kind: 'unsatisfiable' });
    // A zero-length file has no satisfiable range at all.
    expect(parseByteRange('bytes=0-0', 0)).toEqual({ kind: 'unsatisfiable' });
  });

  it('treats a descending window as unsatisfiable, never as an empty read', () => {
    expect(parseByteRange('bytes=9-3', 100)).toEqual({ kind: 'unsatisfiable' });
  });

  it('sizes a window past 2 GiB without clamping — packs are why this exists', () => {
    const twoGiB = 2 * 1024 * 1024 * 1024;
    expect(parseByteRange(`bytes=${twoGiB}-${twoGiB + 15}`, twoGiB + 64)).toEqual({
      kind: 'range',
      start: twoGiB,
      end: twoGiB + 15,
    });
  });
});

describe('isHostFsStableBodyRequest', () => {
  it('excludes only POSTs to the stable dispatcher', () => {
    expect(isHostFsStableBodyRequest({ method: 'POST', url: '/api/hostfs' })).toBe(true);
    expect(isHostFsStableBodyRequest({ method: 'POST', url: '/api/hostfs/' })).toBe(true);
    // The per-op routes carry no JSON body, and read/write are not JSON.
    expect(isHostFsStableBodyRequest({ method: 'POST', url: '/api/hostfs/mkdir?mount=x' })).toBe(
      false
    );
    expect(isHostFsStableBodyRequest({ method: 'GET', url: '/api/hostfs' })).toBe(false);
    expect(isHostFsStableBodyRequest({ method: 'POST', url: '/api/hostfs-admin' })).toBe(false);
    expect(isHostFsStableBodyRequest({ method: 'POST', url: '/api/secrets' })).toBe(false);
    expect(isHostFsStableBodyRequest({})).toBe(false);
  });

  it('ignores the query string when matching', () => {
    expect(isHostFsStableBodyRequest({ method: 'POST', url: '/api/hostfs?x=1' })).toBe(true);
  });
});

describe('resolveWithinRoot', () => {
  it('resolves the root itself and nested paths', async () => {
    expect(await resolveWithinRoot(root, '')).toBe(root);
    expect(await resolveWithinRoot(root, 'a/b')).toBe(join(root, 'a/b'));
  });

  it('rejects lexical escapes even for non-existent paths', async () => {
    await expect(resolveWithinRoot(root, '../x')).rejects.toMatchObject({ code: 'EACCES' });
    await expect(resolveWithinRoot(root, 'a/../../x')).rejects.toMatchObject({ code: 'EACCES' });
  });

  it('rejects writes under an escaping symlinked ancestor', async () => {
    await expect(resolveWithinRoot(root, 'escape-link/new-file.txt')).rejects.toMatchObject({
      code: 'EACCES',
    });
  });
});
