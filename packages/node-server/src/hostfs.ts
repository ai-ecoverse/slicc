import type { ErrorRequestHandler, Express, Request, Response } from 'express';
import express from 'express';
import { createReadStream, type Stats } from 'fs';
import { lstat, mkdir, readdir, realpath, rename, rm, stat, writeFile } from 'fs/promises';
import { dirname, resolve, sep } from 'path';

import type { HostMountMapping } from './runtime-flags.js';

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
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const mapped = toFsCodeError(err);
  res.status(mapped.status).json({ code: mapped.code, message: mapped.message });
}

function escapeError(target: string): NodeJS.ErrnoException {
  const err = new Error(`path escapes the mount root: ${target}`) as NodeJS.ErrnoException;
  err.code = 'EACCES';
  return err;
}

function isWithin(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep);
}

export async function resolveWithinRoot(root: string, relPath: string): Promise<string> {
  const cleaned = relPath.replace(/^\/+/, '');
  const target = resolve(root, cleaned);
  if (!isWithin(root, target)) throw escapeError(target);

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
  path: string;

  root: string;
}

export type ParsedByteRange =
  | { kind: 'none' }
  | { kind: 'range'; start: number; end: number }
  | { kind: 'unsatisfiable' };

const NO_RANGE: ParsedByteRange = { kind: 'none' };
const UNSATISFIABLE: ParsedByteRange = { kind: 'unsatisfiable' };

export function parseByteRange(header: string | undefined, size: number): ParsedByteRange {
  if (!header) return NO_RANGE;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return NO_RANGE;
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return NO_RANGE;
  if (size === 0) return UNSATISFIABLE;

  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (suffix === 0) return UNSATISFIABLE;
    return { kind: 'range', start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(rawStart);
  if (start >= size) return UNSATISFIABLE;

  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (end < start) return UNSATISFIABLE;
  return { kind: 'range', start, end };
}

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

    res.once('close', () => {
      stream.destroy();
      resolveStream();
    });
    res.once('finish', resolveStream);
  });
}

interface CacheValidator {
  etag: string;
  lastModified: string;

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

function stripWeak(tag: string): string {
  return tag.startsWith('W/') ? tag.slice(2) : tag;
}

function isNotModified(req: Request, v: CacheValidator): boolean {
  const ifNoneMatch = req.header('if-none-match');
  if (ifNoneMatch !== undefined) {
    if (ifNoneMatch.trim() === '*') return true;
    return ifNoneMatch.split(',').some((tag) => stripWeak(tag.trim()) === stripWeak(v.etag));
  }
  const ifModifiedSince = req.header('if-modified-since');
  if (ifModifiedSince === undefined) return false;
  const since = Date.parse(ifModifiedSince);

  if (Number.isNaN(since)) return false;
  return v.mtimeSeconds * 1000 <= since;
}

function ifRangeAllowsRange(req: Request, v: CacheValidator): boolean {
  const ifRange = req.header('if-range');
  if (ifRange === undefined) return true;
  const value = ifRange.trim();
  if (value.startsWith('"') || value.startsWith('W/')) return value === v.etag;
  const asDate = Date.parse(value);
  if (Number.isNaN(asDate)) return false;
  return v.mtimeSeconds * 1000 === asDate;
}

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

const HOSTFS_STABLE_PATH = '/api/hostfs';

export const HOSTFS_STABLE_MAX_BODY_BYTES = 1024 * 1024;

function isHostFsPath(path: string): boolean {
  return path === HOSTFS_STABLE_PATH || path.startsWith(`${HOSTFS_STABLE_PATH}/`);
}

export function isHostFsStableBodyRequest(req: { method?: string; url?: string }): boolean {
  if (req.method !== 'POST') return false;
  const path = (req.url ?? '').split('?')[0];
  return path === HOSTFS_STABLE_PATH || path === `${HOSTFS_STABLE_PATH}/`;
}

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

const STABLE_OPS = ['list', 'stat', 'mkdir', 'rename', 'remove'] as const;
type StableOp = (typeof STABLE_OPS)[number];

function isStableOp(value: unknown): value is StableOp {
  return typeof value === 'string' && (STABLE_OPS as readonly string[]).includes(value);
}

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

function isRecursive(value: unknown): boolean {
  return value === true || value === '1' || value === 1;
}

async function listOp(target: string): Promise<{ entries: unknown[] }> {
  const dirents = await readdir(target, { withFileTypes: true });
  const entries = await Promise.all(
    dirents.map(async (d) => {
      if (d.isDirectory()) return { name: d.name, kind: 'directory' };
      try {
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
        return { name: d.name, kind: 'file' };
      }
    })
  );
  return { entries };
}

async function statOp(target: string): Promise<ReturnType<typeof statPayload>> {
  return statPayload(await stat(target));
}

async function readOp(target: string, req: Request, res: Response): Promise<void> {
  const s = await stat(target);
  if (s.isDirectory()) {
    sendFsError(res, Object.assign(new Error(`is a directory: ${target}`), { code: 'EISDIR' }));
    return;
  }
  const validator = cacheValidator(s);

  const common = {
    'Accept-Ranges': 'bytes',
    ETag: validator.etag,
    'Last-Modified': validator.lastModified,
  };
  if (isNotModified(req, validator)) {
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
      try {
        const existing = await lstat(target);
        if (existing.isDirectory()) {
          sendFsError(
            res,
            Object.assign(new Error(`is a directory: ${target}`), { code: 'EISDIR' })
          );
          return;
        }
      } catch {}
      await mkdir(dirname(target), { recursive: true });
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

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

  app.use(hostFsBodyErrorHandler);
}
