/**
 * Token-scoped synchronous-fs dispatch.
 *
 * The kernel-worker sync-fs responder resolves a per-realm capability token
 * (see `sync-fs-token-registry.ts`) to that realm's `{ fs, cwd }` and runs the
 * requested fs op HERE — through the realm's own `ctx.fs`, which for a scoop is
 * a `RestrictedFS` wrapped by the sudo-fs `Proxy`. Routing every op through
 * that handle is what makes the synchronous bridge inherit the exact same
 * path-ACL + sudo enforcement the async `vfs` RPC already has
 * (`realm-host.ts` `dispatchVfs`): an out-of-sandbox path throws `EACCES` /
 * `ENOENT` here just as it does on the async path.
 *
 * Errors are surfaced as a POSIX errno (`FsError.code`, else `EIO`) so the SW
 * handler can carry it over the HTTP boundary and the realm shim can rethrow an
 * `Error` whose `.code` matches — the contract ported Node code relies on.
 *
 * NOTE: this module is pure (no BroadcastChannel / SW). Phase-2 routes
 * `stat` / `readdir` / `exists` through the SW wire in addition to the
 * phase-1 `read` / `write`, and the sync-exec flush-before path adds
 * `mkdir` / `rm`. The POSIX ops (`rename` / `unlink` / `rmdir` / `symlink` /
 * `readlink` / `chmod` / `utimes`) back the Pyodide live-VFS plugin
 * (`live-vfs-fs.ts`), which needs single-node semantics rather than the
 * recursive `rm` / `mkdir -p` the flush path uses.
 */

import type { FsStat } from 'just-bash';
import { resolveSyncFsToken, type SyncFsTokenEntry } from './sync-fs-token-registry.js';
// The wire-payload types live in the dependency-free wire module (their single
// source of truth); import them DOWN from there and re-export so this module's
// existing consumers keep their import site. This is a forward edge — never a
// back-edge into wire.
import type { SyncFsRequest, SyncFsResult } from './sync-fs-wire.js';

export type { SyncFsOp, SyncFsRequest, SyncFsResult } from './sync-fs-wire.js';

/**
 * Map any thrown error to a POSIX errno result. Shared with the exec channel
 * (`sync-exec-dispatch.ts`) so a sudo denial's `EACCES` survives on BOTH paths
 * rather than being flattened to a generic `EIO`.
 */
export function toErrno(err: unknown): SyncFsResult {
  const message = err instanceof Error ? err.message : String(err);
  // Validate the errno shape for EVERY error (FsError, sync-fs-cache errors, or
  // anything else with a `.code`). A malformed `.code` would otherwise become an
  // `x-slicc-fs-errno` header value and throw in the `Headers` constructor; keep
  // the guard here so both branches are symmetric and only a well-formed errno
  // (`E` + uppercase) crosses the wire, defaulting to `EIO`.
  const code = (err as { code?: unknown })?.code;
  if (typeof code === 'string' && /^E[A-Z]+$/.test(code)) {
    return { ok: false, errno: code, message };
  }
  return { ok: false, errno: 'EIO', message };
}

/**
 * Run a single sync-fs op against the token's realm fs. Resolves to bytes
 * (`read`), a JSON value (`exists` / `stat` / `readdir`), or an errno result.
 * An unknown / revoked token fails closed with `EACCES` — never the global VFS.
 */
export async function dispatchSyncFs(req: SyncFsRequest): Promise<SyncFsResult> {
  const entry = resolveSyncFsToken(req.token);
  if (!entry) {
    return { ok: false, errno: 'EACCES', message: 'sync-fs: unknown or revoked token' };
  }
  const { fs, cwd } = entry;
  try {
    // Inside the try so a throwing resolvePath (a future mount-backed /
    // sudo-Proxy ctx.fs) maps to an errno result rather than rejecting the
    // promise (which would strand the responder's post — see sync-fs-responder).
    const resolved = fs.resolvePath(cwd, req.path);
    switch (req.op) {
      case 'read':
        return { ok: true, kind: 'bytes', bytes: await fs.readFileBuffer(resolved) };
      case 'write':
        await fs.writeFile(resolved, req.body ?? new Uint8Array(0));
        return { ok: true, kind: 'void' };
      case 'exists':
        return { ok: true, kind: 'json', json: await fs.exists(resolved) };
      case 'stat':
        return { ok: true, kind: 'json', json: statJson(await fs.stat(resolved)) };
      case 'lstat':
        return { ok: true, kind: 'json', json: statJson(await fs.lstat(resolved)) };
      case 'readdir':
        return { ok: true, kind: 'json', json: await fs.readdir(resolved) };
      case 'mkdir':
        await fs.mkdir(resolved, { recursive: true });
        return { ok: true, kind: 'void' };
      case 'rm':
        await fs.rm(resolved, { recursive: true });
        return { ok: true, kind: 'void' };
      case 'rename': {
        // Probe `rename` then `mv` (VfsAdapter exposes `mv`); copy+remove
        // only when neither is present, and never when dest is the same inode
        // as source (#3107). First-use import: this module is on the
        // kernel-worker boot path (host → sync-fs-responder).
        const dest = fs.resolvePath(cwd, req.arg2 ?? '');
        const { renameViaFs } = await import('./rename-via-fs.js');
        await renameViaFs(fs, resolved, dest);
        return { ok: true, kind: 'void' };
      }
      default:
        return await dispatchPosixOp(fs, resolved, req);
    }
  } catch (err) {
    return toErrno(err);
  }
}

/** Wire shape of a `stat` / `lstat` result. */
export interface SyncFsStatJson {
  isDirectory: boolean;
  isFile: boolean;
  isSymbolicLink: boolean;
  size: number;
  mode: number;
  mtimeMs: number;
}

function statJson(s: FsStat): SyncFsStatJson {
  return {
    isDirectory: s.isDirectory,
    isFile: s.isFile,
    isSymbolicLink: s.isSymbolicLink ?? false,
    size: s.size,
    mode: s.mode,
    mtimeMs: s.mtime instanceof Date ? s.mtime.getTime() : 0,
  };
}

/** An `Error` carrying a POSIX `.code`, which {@link toErrno} forwards. */
function posixError(code: string, path: string): Error & { code: string } {
  return Object.assign(new Error(`${code}: ${path}`), { code });
}

/**
 * The single-node POSIX ops. `unlink` / `rmdir` check type and emptiness
 * themselves because `ctx.fs.rm` is a looser primitive: an unchecked `rmdir`
 * would delete a populated tree.
 */
async function dispatchPosixOp(
  fs: SyncFsTokenEntry['fs'],
  resolved: string,
  req: SyncFsRequest
): Promise<SyncFsResult> {
  switch (req.op) {
    case 'unlink': {
      if ((await fs.lstat(resolved)).isDirectory) throw posixError('EISDIR', resolved);
      await fs.rm(resolved);
      return { ok: true, kind: 'void' };
    }
    case 'rmdir': {
      if (!(await fs.lstat(resolved)).isDirectory) throw posixError('ENOTDIR', resolved);
      if ((await fs.readdir(resolved)).length > 0) throw posixError('ENOTEMPTY', resolved);
      await fs.rm(resolved, { recursive: true });
      return { ok: true, kind: 'void' };
    }
    case 'symlink':
      // Stored verbatim: a relative target resolves against the link's
      // directory at use time, as symlink(2) does.
      if (!req.arg2) throw posixError('EINVAL', resolved);
      await fs.symlink(req.arg2, resolved);
      return { ok: true, kind: 'void' };
    case 'readlink':
      return { ok: true, kind: 'json', json: await fs.readlink(resolved) };
    case 'chmod':
      if (typeof req.mode !== 'number') throw posixError('EINVAL', resolved);
      await fs.chmod(resolved, req.mode);
      return { ok: true, kind: 'void' };
    case 'utimes':
      if (typeof req.atimeMs !== 'number' || typeof req.mtimeMs !== 'number') {
        throw posixError('EINVAL', resolved);
      }
      await fs.utimes(resolved, new Date(req.atimeMs), new Date(req.mtimeMs));
      return { ok: true, kind: 'void' };
    default:
      return { ok: false, errno: 'EINVAL', message: `sync-fs: unknown op '${req.op as string}'` };
  }
}
