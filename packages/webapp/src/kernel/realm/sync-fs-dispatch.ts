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
 * phase-1 `read` / `write`; the rest of the op set is kept for the responder's
 * completeness but is not reachable from the SW handler today.
 */

import { resolveSyncFsToken } from './sync-fs-token-registry.js';

export type SyncFsOp = 'read' | 'write' | 'exists' | 'stat' | 'readdir' | 'mkdir' | 'rm' | 'rename';

export interface SyncFsRequest {
  token: string;
  op: SyncFsOp;
  path: string;
  /** Write payload for `op: 'write'`. */
  body?: Uint8Array;
  /** Second path argument for `op: 'rename'` (the destination). */
  arg2?: string;
}

/**
 * A dispatch result. The success arm is a discriminated sub-union on `kind` so
 * a consumer (e.g. the SW `buildResponse`) is forced to handle every payload
 * shape: `bytes` (a `read`), `json` (a phase-2 `stat`/`readdir`/`exists`), or
 * `void` (a `write`/`mkdir`/`rm`/`rename`). The old shape had independent
 * `bytes?`/`json?` optionals, which let `buildResponse` silently drop a `json`
 * result — a latent bug once phase-2 wires metadata through the SW.
 */
export type SyncFsResult =
  | { ok: true; kind: 'bytes'; bytes: Uint8Array }
  | { ok: true; kind: 'json'; json: unknown }
  | { ok: true; kind: 'void' }
  | { ok: false; errno: string; message: string };

/** Map any thrown error to a POSIX errno result. */
function toErrno(err: unknown): SyncFsResult {
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
      case 'stat': {
        const s = await fs.stat(resolved);
        return {
          ok: true,
          kind: 'json',
          json: { isDirectory: s.isDirectory, isFile: s.isFile, size: s.size },
        };
      }
      case 'readdir':
        return { ok: true, kind: 'json', json: await fs.readdir(resolved) };
      case 'mkdir':
        await fs.mkdir(resolved, { recursive: true });
        return { ok: true, kind: 'void' };
      case 'rm':
        await fs.rm(resolved, { recursive: true });
        return { ok: true, kind: 'void' };
      case 'rename': {
        // Extends realm-host.ts dispatchVfs (which probes only `rename`):
        // production ctx.fs (VfsAdapter, possibly sudo-wrapped) exposes `mv`,
        // not `rename`, so probe `mv` too, then fall back to copy+remove when
        // neither is present. (Phase-2 only — the phase-1 SW wire is
        // read/write; the responder keeps this for completeness.)
        const dest = fs.resolvePath(cwd, req.arg2 ?? '');
        const maybe = fs as {
          rename?: (a: string, b: string) => Promise<void>;
          mv?: (a: string, b: string) => Promise<void>;
        };
        if (maybe.rename) {
          await maybe.rename(resolved, dest);
        } else if (maybe.mv) {
          await maybe.mv(resolved, dest);
        } else {
          const content = await fs.readFileBuffer(resolved);
          await fs.writeFile(dest, content);
          await fs.rm(resolved, { recursive: true });
        }
        return { ok: true, kind: 'void' };
      }
      default:
        return { ok: false, errno: 'EINVAL', message: `sync-fs: unknown op '${req.op as string}'` };
    }
  } catch (err) {
    return toErrno(err);
  }
}
