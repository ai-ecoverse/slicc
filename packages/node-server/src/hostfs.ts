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
 */

import type { Express, Request, Response } from 'express';
import express from 'express';
import type { Stats } from 'fs';
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'fs/promises';
import { dirname, resolve, sep } from 'path';

import type { HostMountMapping } from './runtime-flags.js';

/** Matches the webapp's hostfs body cap (backend-hostfs.ts). */
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

interface HostMountRoot {
  /** SLICC target path, e.g. /mnt/project. */
  path: string;
  /** realpath()'d OS root. */
  root: string;
}

function statPayload(s: Stats): { kind: 'file' | 'directory'; size: number; mtime: number } {
  return {
    kind: s.isDirectory() ? 'directory' : 'file',
    size: s.isDirectory() ? 0 : s.size,
    mtime: Math.round(s.mtimeMs),
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

/**
 * Register the /api/hostfs routes for the resolved mount roots. The route
 * surface mirrors `MountBackend` 1:1 (webapp `backend-hostfs.ts`):
 *
 *   GET    /api/hostfs/list?mount=&path=          → { entries: [...] }
 *   GET    /api/hostfs/stat?mount=&path=          → { kind, size, mtime }
 *   GET    /api/hostfs/read?mount=&path=          → octet-stream body
 *   PUT    /api/hostfs/write?mount=&path=         ← octet-stream body
 *   POST   /api/hostfs/mkdir?mount=&path=
 *   DELETE /api/hostfs/remove?mount=&path=[&recursive=1]
 *
 * Errors are `{ code, message }` JSON with an errno-derived status so the
 * webapp backend can rethrow faithful `FsError`s.
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

  app.get(
    '/api/hostfs/list',
    withTarget(async (target, _req, res) => {
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
              lastModified: Math.round(s.mtimeMs),
            };
          } catch {
            // Raced deletion / dangling link / unreadable: name only.
            return { name: d.name, kind: 'file' };
          }
        })
      );
      res.json({ entries });
    })
  );

  app.get(
    '/api/hostfs/stat',
    withTarget(async (target, _req, res) => {
      res.json(statPayload(await stat(target)));
    })
  );

  app.get(
    '/api/hostfs/read',
    withTarget(async (target, _req, res) => {
      // lstat first so a dangling symlink is ENOENT, a directory is EISDIR.
      const s = await stat(target);
      if (s.isDirectory()) {
        sendFsError(res, Object.assign(new Error(`is a directory: ${target}`), { code: 'EISDIR' }));
        return;
      }
      if (s.size > HOSTFS_MAX_BODY_BYTES) {
        res.status(413).json({
          code: 'EFBIG',
          message: `file exceeds the ${HOSTFS_MAX_BODY_BYTES} byte hostfs cap`,
        });
        return;
      }
      const body = await readFile(target);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.send(body);
    })
  );

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
      await mkdir(target, { recursive: true });
      res.json({ ok: true });
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
      const to = await resolveWithinRoot(entry.root, toRel);
      await rename(target, to);
      res.json({ ok: true });
    })
  );

  app.delete(
    '/api/hostfs/remove',
    withTarget(async (target, req, res) => {
      const isRoot = roots.some((r) => r.root === target);
      if (isRoot) {
        res.status(403).json({ code: 'EACCES', message: 'refusing to remove a mount root' });
        return;
      }
      const recursive = queryString(req, 'recursive') === '1';
      await rm(target, { recursive, force: false });
      res.json({ ok: true });
    })
  );
}
