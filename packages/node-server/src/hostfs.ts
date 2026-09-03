/**
 * Host filesystem bridge — serves the folders named in the mount table
 * (`--mount=<os-path>:<slicc-path>`) to the webapp over the local /api
 * surface, so configured mounts appear in the VFS fully automatically,
 * with no File System Access picker and no Chrome permission prompt.
 *
 * Only paths under a configured mount root are reachable. Every request
 * names a mount by its SLICC target (`?mount=/mnt/project`) plus a
 * mount-relative path (`?path=sub/file.txt`); the mapping to the OS root
 * happens here and `resolveWithinRoot` rejects traversal (`..`) and
 * symlink escapes, so the browser never addresses the host filesystem
 * directly.
 *
 * Protected like every other /api route: same-origin / loopback callers
 * pass, cross-origin callers need the bridge token (see
 * `createThinBridgeCorsMiddleware` in index.ts).
 *
 * Two request shapes reach the same handlers:
 *
 *   - the per-op routes (`GET /api/hostfs/list?mount=&path=` …), kept for
 *     compatibility and used for the body ops (`read`, `write`);
 *   - a single stable `POST /api/hostfs` whose JSON body carries
 *     `{ op, mount, path, … }`.
 *
 * The stable endpoint exists purely to make CORS preflights cacheable. The
 * bridge token travels as a custom header, so every cross-origin hostfs call
 * is a non-simple request, and Chrome's Private Network Access preflights
 * public→loopback traffic regardless — but the preflight cache is keyed by
 * URL, and the per-op URLs are unique per path, so `Access-Control-Max-Age`
 * never got a chance to help (issue #2715: 246,893 `OPTIONS` for 385,033
 * `GET`s in one session). One stable URL collapses that to one preflight per
 * max-age. `read` deliberately stays a `GET` on a per-file URL so the
 * browser HTTP cache can still revalidate large blobs with a 304.
 *
 * `read` also speaks `Range` (single `bytes=` window, 206 + `Content-Range`,
 * 416 when the window is outside the file) and streams every body straight
 * off disk. Before that, one `git` command against a `--mount`ed checkout
 * buffered the whole 92 MB packfile in express AND in the kernel worker, and
 * a pack over `HOSTFS_MAX_BODY_BYTES` was simply unreachable — every git
 * command in such a repo died with isomorphic-git's `InternalError`
 * (issue #2711). The whole-file cap still guards an unranged read; a ranged
 * read is bounded by the window it names, so it is exempt.
 *
 * Streaming cost the route the ETag express used to derive from the buffered
 * body, so `cacheValidator` rebuilds one from the stat and `read` answers
 * `If-None-Match` / `If-Modified-Since` with a `304` and honors `If-Range`.
 * That is not a nicety: a pack URL the browser cannot revalidate is
 * re-transferred on every object lookup, and 220,310 of the 385,033 hostfs
 * GETs in the #2707 baseline were exactly those `304`s.
 *
 * The hostfs surface owns its own body parsing end to end. `index.ts` skips
 * the stable dispatcher in its global `express.json()` filter (via
 * `isHostFsStableBodyRequest`) so the bounded 1 MiB parser here is the one
 * that runs, and `hostFsBodyErrorHandler` maps body-parser failures to the
 * same `{ code, message }` errno shape as every other error on this surface —
 * otherwise express's default handler answers malformed JSON with code-less
 * HTML and the webapp cannot rethrow a faithful `FsError`.
 */

import type { ErrorRequestHandler, Express, Request, Response } from 'express';
import express from 'express';
import { createReadStream, type Stats } from 'fs';
import { lstat, mkdir, readdir, realpath, rename, rm, stat, writeFile } from 'fs/promises';
import { dirname, resolve, sep } from 'path';

import type { HostMountMapping } from './runtime-flags.js';

/**
 * Cap on a WHOLE-FILE `GET /api/hostfs/read` (and on `PUT /write`). It exists
 * because the caller has to hold the entire body in the kernel worker; it is
 * NOT a limit on what the bridge is willing to serve. A ranged read is exempt:
 * the window it asks for is its own bound, the server streams it, and neither
 * side ever materializes more than that window. See `parseByteRange`.
 *
 * Matches the webapp's hostfs body cap (backend-hostfs.ts).
 */
export const HOSTFS_MAX_BODY_BYTES = 100 * 1024 * 1024;

interface FsCodeError {
  status: number;
  code: string;
  message: string;
}

function errnoCode(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

/** Map an fs errno (or traversal rejection) to an HTTP status + FsError code. */
function toFsCodeError(err: unknown): FsCodeError {
  const code = errnoCode(err) ?? 'EIO';
  const message = err instanceof Error ? err.message : String(err);
  switch (code) {
    case 'ENOENT':
      return { status: 404, code, message };
    case 'EACCES':
    case 'EPERM':
      return { status: 403, code: 'EACCES', message };
    case 'EISDIR':
    case 'ENOTDIR':
    case 'ENOTEMPTY':
    case 'EEXIST':
      return { status: 409, code, message };
    default:
      return { status: 500, code, message };
  }
}

function sendFsError(res: Response, err: unknown): void {
  // A streamed body may already have committed the status line; the only
  // honest signal left is a broken connection.
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const mapped = toFsCodeError(err);
  res.status(mapped.status).json({ code: mapped.code, message: mapped.message });
}

/** Traversal/symlink escape → EACCES, so it renders as a permission error. */
function escapeError(target: string): NodeJS.ErrnoException {
  const err = new Error(`path escapes the mount root: ${target}`) as NodeJS.ErrnoException;
  err.code = 'EACCES';
  return err;
}

function isWithin(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep);
}

/**
 * Resolve `relPath` against `root`, rejecting anything that leaves the root
 * either lexically (`..`) or via symlinks. Symlinks *inside* the root that
 * also point inside the root are followed; a link pointing outside is
 * rejected. The check walks to the nearest existing ancestor so that writes
 * to not-yet-existing paths are still validated.
 */
export async function resolveWithinRoot(root: string, relPath: string): Promise<string> {
  const cleaned = relPath.replace(/^\/+/, '');
  const target = resolve(root, cleaned);
  if (!isWithin(root, target)) throw escapeError(target);
  // Walk up to the nearest existing ancestor and realpath it; a symlinked
  // ancestor must still land inside the (already realpath'd) root.
  let probe = target;
  for (;;) {
    try {
      const real = await realpath(probe);
      if (!isWithin(root, real) && probe !== root) throw escapeError(target);
      break;
    } catch (err) {
      if (errnoCode(err) !== 'ENOENT') throw err;
      const parent = dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  return target;
}

export interface HostMountRoot {
  /** SLICC target path, e.g. /mnt/project. */
  path: string;
  /** realpath()'d OS root. */
  root: string;
}

/**
 * What `Range:` asked for, resolved against the file's actual size.
 *
 *   - `none`          — no (or unusable) Range header: serve the whole file.
 *   - `range`         — a satisfiable window, INCLUSIVE on both ends, exactly
 *                       as `Content-Range` and `createReadStream` want it.
 *   - `unsatisfiable` — syntactically fine but outside the file: 416.
 */
export type ParsedByteRange =
  | { kind: 'none' }
  | { kind: 'range'; start: number; end: number }
  | { kind: 'unsatisfiable' };

const NO_RANGE: ParsedByteRange = { kind: 'none' };
const UNSATISFIABLE: ParsedByteRange = { kind: 'unsatisfiable' };

/**
 * Parse a single-range `Range: bytes=…` header against a known file size.
 *
 * Deliberately narrow: one range, `bytes` unit only. RFC 9110 §14.2 says a
 * recipient that cannot make sense of a Range header MUST ignore it and serve
 * the whole representation, so anything malformed — a different unit, a
 * multi-range list, non-digits — returns `none` rather than an error. Only a
 * well-formed range that lies outside the file is a 416, because answering
 * that one with the whole file would silently hand the caller bytes it did
 * not ask for (and a git pack reader would then parse garbage).
 *
 * Both ends of the result are inclusive and clamped into `[0, size - 1]`.
 * A zero-length file has no satisfiable range at all.
 */
export function parseByteRange(header: string | undefined, size: number): ParsedByteRange {
  if (!header) return NO_RANGE;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return NO_RANGE;
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return NO_RANGE;
  if (size === 0) return UNSATISFIABLE;

  if (rawStart === '') {
    // Suffix form `bytes=-N`: the last N bytes. `-0` names nothing.
    const suffix = Number(rawEnd);
    if (suffix === 0) return UNSATISFIABLE;
    return { kind: 'range', start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(rawStart);
  if (start >= size) return UNSATISFIABLE;
  // An open-ended `bytes=N-` runs to EOF; an explicit end past EOF clamps.
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (end < start) return UNSATISFIABLE;
  return { kind: 'range', start, end };
}

/**
 * Stream a file (or a window of it) to the response instead of buffering it.
 *
 * `readFile` + `res.send` held the whole body in the server process — 92 MB
 * per pack read in the benchmark of issue #2707 — for no benefit: express is
 * already writing to a socket. Headers are committed on the stream's `open`,
 * so a failure to open (a raced unlink, EACCES) still rejects BEFORE anything
 * is on the wire and is mapped to the usual errno JSON by the caller. After
 * that point the status line is spent, so a mid-body failure can only be
 * reported by destroying the connection — a truncated body the client's
 * `fetch` rejects on, which its retry path already handles.
 */
async function streamFileBody(
  res: Response,
  target: string,
  status: number,
  headers: Record<string, string>,
  window?: { start: number; end: number }
): Promise<void> {
  const stream = createReadStream(target, window);
  await new Promise<void>((resolveStream, rejectStream) => {
    let committed = false;
    stream.once('open', () => {
      committed = true;
      res.status(status);
      for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
      stream.pipe(res);
    });
    stream.once('error', (err) => {
      if (!committed) {
        rejectStream(err);
        return;
      }
      res.destroy();
      resolveStream();
    });
    // The client hung up (or the pipe finished): either way we are done, and
    // an aborted response must not leave the read fd open.
    res.once('close', () => {
      stream.destroy();
      resolveStream();
    });
    res.once('finish', resolveStream);
  });
}

/**
 * The cache validators for one file, derived from its `stat`.
 *
 * `res.send(body)` used to hand express a buffered body it could hash into an
 * ETag for free. Streaming removed the buffer AND, with it, the ETag — which
 * would have been a straight regression for exactly the files this route was
 * changed for: in the #2707 baseline **220,310 of 385,033** hostfs GETs were
 * answered `304`, i.e. the browser revalidating a pack instead of pulling 92 MB
 * again. So the validator is now derived from the stat we already did.
 *
 * The ETag is STRONG (no `W/`) on purpose: `If-Range` is only defined for a
 * strong validator, and a ranged pack read is the case that matters most here.
 * Strong is justified by what goes into it — inode, size, and an unrounded
 * high-resolution mtime — the same basis nginx and `serve-static` use. The
 * honest limit: a write that lands on the same inode with an identical size
 * AND an mtime deliberately restored (`utimes`) is invisible to it. Nothing
 * git does looks like that (packs are written under a new name), and the
 * alternative — hashing the body — is the buffering we just removed.
 */
interface CacheValidator {
  etag: string;
  lastModified: string;
  /** mtime floored to the second, which is all an HTTP-date can carry. */
  mtimeSeconds: number;
}

function cacheValidator(s: Stats): CacheValidator {
  const mtimeSeconds = Math.floor(s.mtimeMs / 1000);
  return {
    etag: `"${s.size.toString(16)}-${s.mtimeMs.toString(16)}-${Number(s.ino).toString(16)}"`,
    lastModified: new Date(mtimeSeconds * 1000).toUTCString(),
    mtimeSeconds,
  };
}

/** Drop a `W/` prefix so the weak comparison treats `W/"x"` and `"x"` alike. */
function stripWeak(tag: string): string {
  return tag.startsWith('W/') ? tag.slice(2) : tag;
}

/**
 * True when the client already holds this exact representation, so the answer
 * is `304` with no body.
 *
 * RFC 9110 §13.2.1 fixes the precedence: `If-None-Match` decides on its own
 * whenever it is present, and `If-Modified-Since` is only consulted in its
 * absence. Comparison for `If-None-Match` is the WEAK one, so a cached weak
 * form of our tag still matches.
 */
function isNotModified(req: Request, v: CacheValidator): boolean {
  const ifNoneMatch = req.header('if-none-match');
  if (ifNoneMatch !== undefined) {
    if (ifNoneMatch.trim() === '*') return true;
    return ifNoneMatch.split(',').some((tag) => stripWeak(tag.trim()) === stripWeak(v.etag));
  }
  const ifModifiedSince = req.header('if-modified-since');
  if (ifModifiedSince === undefined) return false;
  const since = Date.parse(ifModifiedSince);
  // An unparseable date is not a claim about anything — serve the file.
  if (Number.isNaN(since)) return false;
  return v.mtimeSeconds * 1000 <= since;
}

/**
 * Whether a `Range` may still be honored. `If-Range` says "send me the window
 * only if the representation is still the one I have; otherwise send the
 * whole thing" — so a mismatch downgrades to a plain 200 rather than erroring,
 * which is what keeps a client from stitching a window of the NEW file into a
 * buffer holding the old one. Absent header: nothing to disagree with.
 *
 * Comparison here is STRONG (RFC 9110 §13.1.5): a weak tag never satisfies it.
 */
function ifRangeAllowsRange(req: Request, v: CacheValidator): boolean {
  const ifRange = req.header('if-range');
  if (ifRange === undefined) return true;
  const value = ifRange.trim();
  if (value.startsWith('"') || value.startsWith('W/')) return value === v.etag;
  const asDate = Date.parse(value);
  if (Number.isNaN(asDate)) return false;
  return v.mtimeSeconds * 1000 === asDate;
}

/**
 * Identity/permission fields of a host `fs.Stats`, as the webapp needs them.
 *
 * isomorphic-git's `compareStats` decides whether a working-tree file is
 * still the one the index recorded by comparing mode, mtime, ctime, uid,
 * gid, ino and size. The bridge used to report only `{kind,size,mtime}`, so
 * the comparison was stale for EVERY file — every read-only git command
 * re-hashed the whole tree and rewrote `.git/index` once per file
 * (issue #2708). `mode` is the full `st_mode` (type bits included), so the
 * executable bit survives instead of being flattened to `100644`.
 *
 * Timestamps go over the wire UNROUNDED. isomorphic-git derives the seconds
 * it compares with `Math.floor(ms / 1000)`, so rounding a `.9996 s` stat up
 * lands it in the NEXT second, disagrees with the seconds native git wrote,
 * and makes that one file stale on every single walk. Never round up; JSON
 * carries the fractional double fine.
 */
function statIdentity(s: Stats): {
  ctime: number;
  ino: number;
  uid: number;
  gid: number;
  mode: number;
} {
  return {
    ctime: s.ctimeMs,
    ino: Number(s.ino),
    uid: s.uid,
    gid: s.gid,
    mode: s.mode,
  };
}

function statPayload(s: Stats): {
  kind: 'file' | 'directory';
  size: number;
  mtime: number;
  ctime: number;
  ino: number;
  uid: number;
  gid: number;
  mode: number;
} {
  return {
    kind: s.isDirectory() ? 'directory' : 'file',
    size: s.isDirectory() ? 0 : s.size,
    mtime: s.mtimeMs,
    ...statIdentity(s),
  };
}

/**
 * Resolve the configured mappings to realpath'd roots. Mappings whose OS
 * path does not exist (or is not a directory) are dropped with a warning —
 * a missing folder must not take the whole /api surface down, and the
 * webapp will surface the absent mount as "not mounted".
 */
export async function resolveHostMountRoots(
  mounts: readonly HostMountMapping[],
  warn: (msg: string) => void = (msg) => console.warn(msg)
): Promise<HostMountRoot[]> {
  const roots: HostMountRoot[] = [];
  for (const mapping of mounts) {
    try {
      const root = await realpath(mapping.hostPath);
      const s = await stat(root);
      if (!s.isDirectory()) {
        warn(`--mount ${mapping.hostPath}: not a directory, skipping`);
        continue;
      }
      roots.push({ path: mapping.path, root });
    } catch {
      warn(`--mount ${mapping.hostPath}: does not exist, skipping`);
    }
  }
  return roots;
}

function queryString(req: Request, name: string): string | null {
  const value = req.query[name];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Path of the stable dispatcher. */
const HOSTFS_STABLE_PATH = '/api/hostfs';

/**
 * Bounded body cap for the stable dispatcher — it only ever carries a small
 * JSON envelope, so it has no business inheriting the global 50 MiB limit.
 */
export const HOSTFS_STABLE_MAX_BODY_BYTES = 1024 * 1024;

function isHostFsPath(path: string): boolean {
  return path === HOSTFS_STABLE_PATH || path.startsWith(`${HOSTFS_STABLE_PATH}/`);
}

/**
 * True for a request `index.ts`'s global `express.json()` must NOT consume.
 * The global parser is mounted before these routes with a 50 MiB limit, so
 * without this exclusion it would swallow the stable dispatcher's body first:
 * the route-local 1 MiB cap would never apply, and a malformed body would
 * fail in the global parser and reach express's default (code-less HTML)
 * handler instead of the errno shape every hostfs caller expects. Exported so
 * `index.ts` and the middleware-order test filter identically.
 */
export function isHostFsStableBodyRequest(req: { method?: string; url?: string }): boolean {
  if (req.method !== 'POST') return false;
  const path = (req.url ?? '').split('?')[0];
  return path === HOSTFS_STABLE_PATH || path === `${HOSTFS_STABLE_PATH}/`;
}

/**
 * Map body-parser failures on the hostfs surface to `{ code, message }`.
 * Registered after the routes (express only runs an error handler for
 * middleware mounted before it), so it catches the stable dispatcher's JSON
 * parser AND `PUT /write`'s raw parser. Mirrors swift-server, which answers
 * 400 `EINVAL` for an unparseable body and 413 `EFBIG` for an oversized one.
 * Anything that is not a body-parser error, and every non-hostfs path, is
 * passed through untouched.
 */
const hostFsBodyErrorHandler: ErrorRequestHandler = (err, req, res, next) => {
  const type = (err as { type?: unknown } | null)?.type;
  if (typeof type !== 'string' || res.headersSent || !isHostFsPath(req.path)) {
    next(err);
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  if (type === 'entity.too.large') {
    res.status(413).json({ code: 'EFBIG', message: `hostfs body too large: ${message}` });
    return;
  }
  res.status(400).json({ code: 'EINVAL', message: `hostfs body rejected: ${message}` });
};

/** Ops reachable through the stable `POST /api/hostfs` endpoint. */
const STABLE_OPS = ['list', 'stat', 'mkdir', 'rename', 'remove'] as const;
type StableOp = (typeof STABLE_OPS)[number];

function isStableOp(value: unknown): value is StableOp {
  return typeof value === 'string' && (STABLE_OPS as readonly string[]).includes(value);
}

/**
 * JSON body of the stable `POST /api/hostfs` endpoint. Every field is
 * `unknown` because it arrives off the wire: `op` is narrowed by `isStableOp`
 * and the rest by `bodyString` / `isRecursive` before anything touches the
 * filesystem.
 */
interface HostFsStableRequest {
  op?: unknown;
  mount?: unknown;
  path?: unknown;
  to?: unknown;
  recursive?: unknown;
}

function bodyString(body: HostFsStableRequest, name: 'mount' | 'path' | 'to'): string | null {
  const value = body[name];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** `recursive` accepts the query-string `'1'` and a JSON `true` alike. */
function isRecursive(value: unknown): boolean {
  return value === true || value === '1' || value === 1;
}

/** `readdir` + a stat per entry, so consumers get size/mtime without an N+1. */
async function listOp(target: string): Promise<{ entries: unknown[] }> {
  const dirents = await readdir(target, { withFileTypes: true });
  const entries = await Promise.all(
    dirents.map(async (d) => {
      if (d.isDirectory()) return { name: d.name, kind: 'directory' };
      try {
        // stat() follows symlinks, so a link to a directory classifies as
        // a directory — matching what every subsequent access sees (and
        // the swift server, whose fileExists follows links). Escaping
        // links are still refused at access time by resolveWithinRoot.
        const s = await stat(resolve(target, d.name));
        if (s.isDirectory()) return { name: d.name, kind: 'directory' };
        return {
          name: d.name,
          kind: 'file',
          size: s.size,
          lastModified: s.mtimeMs,
          ...statIdentity(s),
        };
      } catch {
        // Raced deletion / dangling link / unreadable: name only.
        return { name: d.name, kind: 'file' };
      }
    })
  );
  return { entries };
}

/** Shared by the stable dispatcher and `GET /api/hostfs/stat` — same payload. */
async function statOp(target: string): Promise<ReturnType<typeof statPayload>> {
  return statPayload(await stat(target));
}

/**
 * `GET /api/hostfs/read` — the whole file, or the `Range` window it asked for,
 * or `304` when the client already holds it.
 *
 * Writes the response itself rather than returning a payload, because the body
 * is streamed: buffering a 92 MB packfile in express to `res.send` it was pure
 * overhead, and a pack over `HOSTFS_MAX_BODY_BYTES` had no way through at all
 * (issue #2711). The cap survives only for the unranged read, whose caller has
 * to hold the whole body.
 *
 * Conditional handling is not optional garnish here. Streaming cost us the
 * ETag express derived from the buffered body, and a pack URL that cannot be
 * revalidated is re-transferred on every object lookup — the opposite of the
 * fix. See {@link cacheValidator}.
 */
async function readOp(target: string, req: Request, res: Response): Promise<void> {
  const s = await stat(target);
  if (s.isDirectory()) {
    sendFsError(res, Object.assign(new Error(`is a directory: ${target}`), { code: 'EISDIR' }));
    return;
  }
  const validator = cacheValidator(s);
  // Every answer carries the validators, 304 included — that is how the client
  // refreshes its stored response metadata.
  const common = {
    'Accept-Ranges': 'bytes',
    ETag: validator.etag,
    'Last-Modified': validator.lastModified,
  };
  if (isNotModified(req, validator)) {
    // 304 MUST NOT carry a body; `end()` (not `json()`) keeps it that way and
    // stops express from attaching a Content-Type for content that isn't there.
    res.status(304).set(common).end();
    return;
  }
  const range = ifRangeAllowsRange(req, validator)
    ? parseByteRange(req.header('range'), s.size)
    : NO_RANGE;
  if (range.kind === 'unsatisfiable') {
    res
      .status(416)
      .set({ ...common, 'Content-Range': `bytes */${s.size}` })
      .json({ code: 'EINVAL', message: `range not satisfiable for a ${s.size} byte file` });
    return;
  }
  const bodyHeaders = { ...common, 'Content-Type': 'application/octet-stream' };
  if (range.kind === 'range') {
    // No size cap here on purpose: the window IS the bound, and the body is
    // streamed, so neither the bridge nor the caller ever holds more than the
    // bytes that were asked for. This is what lets git reach a pack larger
    // than HOSTFS_MAX_BODY_BYTES at all.
    await streamFileBody(
      res,
      target,
      206,
      {
        ...bodyHeaders,
        'Content-Range': `bytes ${range.start}-${range.end}/${s.size}`,
        'Content-Length': String(range.end - range.start + 1),
      },
      range
    );
    return;
  }
  if (s.size > HOSTFS_MAX_BODY_BYTES) {
    res
      .status(413)
      .set(common)
      .json({
        code: 'EFBIG',
        message: `file exceeds the ${HOSTFS_MAX_BODY_BYTES} byte hostfs whole-file cap; read it with a Range request`,
      });
    return;
  }
  await streamFileBody(res, target, 200, { ...bodyHeaders, 'Content-Length': String(s.size) });
}

async function mkdirOp(target: string): Promise<{ ok: true }> {
  await mkdir(target, { recursive: true });
  return { ok: true };
}

async function renameOp(from: string, to: string): Promise<{ ok: true }> {
  await rename(from, to);
  return { ok: true };
}

async function removeOp(
  target: string,
  recursive: boolean,
  roots: readonly HostMountRoot[]
): Promise<{ ok: true }> {
  if (roots.some((r) => r.root === target)) {
    throw Object.assign(new Error('refusing to remove a mount root'), { code: 'EACCES' });
  }
  await rm(target, { recursive, force: false });
  return { ok: true };
}

/**
 * Register the /api/hostfs routes for the resolved mount roots. The route
 * surface mirrors `MountBackend` 1:1 (webapp `backend-hostfs.ts`):
 *
 *   POST   /api/hostfs           ← { op, mount, path, to?, recursive? }
 *   GET    /api/hostfs/list?mount=&path=          → { entries: [...] }
 *   GET    /api/hostfs/stat?mount=&path=          → { kind, size, mtime, ctime, ino, uid, gid, mode }
 *   GET    /api/hostfs/read?mount=&path=          → octet-stream body
 *   PUT    /api/hostfs/write?mount=&path=         ← octet-stream body
 *   POST   /api/hostfs/mkdir?mount=&path=
 *   POST   /api/hostfs/rename?mount=&path=&to=
 *   DELETE /api/hostfs/remove?mount=&path=[&recursive=1]
 *
 * `POST /api/hostfs` is the preflight-cacheable form of `list`/`stat`/
 * `mkdir`/`rename`/`remove` — one URL for all of them, so one CORS preflight
 * covers the whole `Access-Control-Max-Age` window instead of one per path
 * (#2715). It is purely a transport change: same handlers, same payloads,
 * same errno JSON. The per-op routes stay for compatibility (older webapps,
 * `curl`) and remain the only form for the two body ops.
 *
 * Errors are `{ code, message }` JSON with an errno-derived status so the
 * webapp backend can rethrow faithful `FsError`s — including body-parser
 * failures, via `hostFsBodyErrorHandler` registered at the end. A bridge that
 * predates the stable endpoint answers `POST /api/hostfs` with a framework 404
 * that has no `code`, which is how the webapp detects it and falls back to the
 * per-op routes — so every error this route emits MUST carry a `code`.
 */
export function registerHostFsRoutes(app: Express, roots: readonly HostMountRoot[]): void {
  const byPath = new Map(roots.map((r) => [r.path, r]));

  const withTarget = (
    handler: (target: string, req: Request, res: Response) => Promise<void>
  ): ((req: Request, res: Response) => void) => {
    return (req, res) => {
      void (async () => {
        const mount = queryString(req, 'mount');
        const rel = queryString(req, 'path') ?? '';
        const entry = mount ? byPath.get(mount) : undefined;
        if (!entry) {
          res.status(404).json({ code: 'ENOENT', message: `no such mount: ${mount ?? ''}` });
          return;
        }
        try {
          const target = await resolveWithinRoot(entry.root, rel);
          await handler(target, req, res);
        } catch (err) {
          sendFsError(res, err);
        }
      })();
    };
  };

  // Stable-URL dispatcher. Mounted before the per-op routes so `/api/hostfs`
  // is matched exactly; express keeps `/api/hostfs/mkdir` distinct.
  app.post(
    HOSTFS_STABLE_PATH,
    express.json({ limit: HOSTFS_STABLE_MAX_BODY_BYTES }),
    (req, res) => {
      void (async () => {
        const body = (req.body ?? {}) as HostFsStableRequest;
        const op = body.op;
        if (!isStableOp(op)) {
          res.status(400).json({ code: 'EINVAL', message: `unsupported hostfs op: ${String(op)}` });
          return;
        }
        const mount = bodyString(body, 'mount');
        const entry = mount ? byPath.get(mount) : undefined;
        if (!entry) {
          res.status(404).json({ code: 'ENOENT', message: `no such mount: ${mount ?? ''}` });
          return;
        }
        try {
          const target = await resolveWithinRoot(entry.root, bodyString(body, 'path') ?? '');
          switch (op) {
            case 'list':
              res.json(await listOp(target));
              return;
            case 'stat':
              res.json(await statOp(target));
              return;
            case 'mkdir':
              res.json(await mkdirOp(target));
              return;
            case 'rename': {
              const toRel = bodyString(body, 'to');
              if (!toRel) {
                res.status(400).json({ code: 'EINVAL', message: 'rename requires to' });
                return;
              }
              res.json(await renameOp(target, await resolveWithinRoot(entry.root, toRel)));
              return;
            }
            case 'remove':
              res.json(await removeOp(target, isRecursive(body.recursive), roots));
              return;
          }
        } catch (err) {
          sendFsError(res, err);
        }
      })();
    }
  );

  app.get(
    '/api/hostfs/list',
    withTarget(async (target, _req, res) => {
      res.json(await listOp(target));
    })
  );

  app.get(
    '/api/hostfs/stat',
    withTarget(async (target, _req, res) => {
      res.json(await statOp(target));
    })
  );

  app.get('/api/hostfs/read', withTarget(readOp));

  app.put(
    '/api/hostfs/write',
    express.raw({ type: () => true, limit: HOSTFS_MAX_BODY_BYTES }),
    withTarget(async (target, req, res) => {
      // Refuse to clobber a directory with a file (fs would throw EISDIR on
      // open, but check explicitly so the error is deterministic).
      try {
        const existing = await lstat(target);
        if (existing.isDirectory()) {
          sendFsError(
            res,
            Object.assign(new Error(`is a directory: ${target}`), { code: 'EISDIR' })
          );
          return;
        }
      } catch {
        /* ENOENT — fresh file */
      }
      await mkdir(dirname(target), { recursive: true });
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      // Write-then-rename would break hardlinks and xattrs on user files;
      // plain writeFile matches what local tools do.
      await writeFile(target, body);
      res.json({ ok: true });
    })
  );

  app.post(
    '/api/hostfs/mkdir',
    withTarget(async (target, _req, res) => {
      res.json(await mkdirOp(target));
    })
  );

  app.post(
    '/api/hostfs/rename',
    withTarget(async (target, req, res) => {
      const mount = queryString(req, 'mount');
      const toRel = queryString(req, 'to');
      const entry = mount ? byPath.get(mount) : undefined;
      if (!entry || !toRel) {
        res.status(400).json({ code: 'EINVAL', message: 'rename requires mount and to' });
        return;
      }
      res.json(await renameOp(target, await resolveWithinRoot(entry.root, toRel)));
    })
  );

  app.delete(
    '/api/hostfs/remove',
    withTarget(async (target, req, res) => {
      res.json(await removeOp(target, queryString(req, 'recursive') === '1', roots));
    })
  );

  // Last: only reachable for errors raised by middleware mounted above it.
  app.use(hostFsBodyErrorHandler);
}
