/**
 * Token-scoped synchronous-exec dispatch.
 *
 * The kernel-worker responder resolves a per-realm capability token (see
 * `sync-fs-token-registry.ts`) to that realm's `{ exec, cwd }` and runs the
 * requested command HERE — through the realm's own `ctx.exec`, the same handle
 * the async `exec.run` / `exec.spawn` RPC uses (`realm-host.ts` `dispatchExec`).
 * Routing through it is what makes the synchronous bridge inherit the exact
 * same sudo command guard, path ACLs, and secret masking the async path has.
 *
 * The realm worker is blocked on a synchronous XHR while this runs, but the
 * sudo brokers live in the kernel worker (HTTP) or the page (panel-RPC), so an
 * approval prompt still renders and resolves normally — the blocked thread is
 * never on the approval path.
 *
 * The result crosses back as JSON (`{ stdout, stderr, exitCode }`) rather than
 * an errno: a non-zero exit is a normal outcome for `spawnSync`, not a
 * transport failure. Only a genuine failure (no `ctx.exec`, a malformed
 * request, an unknown token, a throwing shell) becomes an errno result.
 */

import { type SyncFsRequest, type SyncFsResult, toErrno } from './sync-fs-dispatch.js';
import { resolveSyncFsToken } from './sync-fs-token-registry.js';
import { SYNC_EXEC_MAX_TIMEOUT_MS } from './sync-fs-wire.js';

/** Discriminator distinguishing an exec request from an fs one on the wire. */
export const SYNC_EXEC_CHANNEL = 'exec';

/** POST body the realm bridge sends on the `exec` route. */
export interface SyncExecRequestPayload {
  /** Command string (shell form) or argv (shell-free form, argv[0] = program). */
  command: string | string[];
  /** Shell-free argv tail for the string form — mirrors `exec.spawn`'s `args`. */
  args?: string[];
  /** Buffered stdin for the one-shot command. */
  stdin?: string;
  /** Caller budget in ms, clamped to {@link SYNC_EXEC_MAX_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** SW → responder envelope for one synchronous exec. */
export interface SyncExecRequest extends SyncExecRequestPayload {
  token: string;
  channel: typeof SYNC_EXEC_CHANNEL;
}

/** Buffered outcome of a synchronous exec, JSON-encoded back to the realm. */
export interface SyncExecResultPayload {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Narrow a wire request to the exec channel. */
export function isSyncExecRequest(req: SyncFsRequest | SyncExecRequest): req is SyncExecRequest {
  return (req as SyncExecRequest).channel === SYNC_EXEC_CHANNEL;
}

/**
 * Validate the request envelope. Returns the normalized `{ cmd, argv }` pair or
 * an errno result — a malformed payload must never reach `ctx.exec`.
 */
function normalizeCommand(
  req: SyncExecRequest
): { cmd: string; args?: string[] } | { errno: string; message: string } {
  const { command } = req;
  if (Array.isArray(command)) {
    if (command.length === 0 || !command.every((a) => typeof a === 'string')) {
      return { errno: 'EINVAL', message: 'sync-exec: argv must be a non-empty string[]' };
    }
    const [cmd, ...rest] = command;
    return { cmd: cmd!, args: rest };
  }
  if (typeof command !== 'string' || command.length === 0) {
    return { errno: 'EINVAL', message: 'sync-exec: command must be a non-empty string' };
  }
  if (req.args !== undefined) {
    if (!Array.isArray(req.args) || !req.args.every((a) => typeof a === 'string')) {
      return { errno: 'EINVAL', message: 'sync-exec: args must be a string[]' };
    }
    return { cmd: command, args: req.args };
  }
  return { cmd: command };
}

/**
 * Clamp the caller's budget into `(0, SYNC_EXEC_MAX_TIMEOUT_MS]`. A blocked
 * realm worker cannot be interrupted, so an unbounded or absent budget would
 * make a runaway command unkillable short of terminating the realm.
 */
export function clampSyncExecTimeout(timeoutMs: number | undefined, fallbackMs: number): number {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Math.min(fallbackMs, SYNC_EXEC_MAX_TIMEOUT_MS);
  }
  return Math.min(timeoutMs, SYNC_EXEC_MAX_TIMEOUT_MS);
}

/**
 * Run one synchronous exec against the token's realm. Resolves to a JSON
 * `{ stdout, stderr, exitCode }` payload, or an errno result. An unknown /
 * revoked token fails closed with `EACCES` — never the ambient shell.
 */
export async function dispatchSyncExec(req: SyncExecRequest): Promise<SyncFsResult> {
  const entry = resolveSyncFsToken(req.token);
  if (!entry) {
    return { ok: false, errno: 'EACCES', message: 'sync-exec: unknown or revoked token' };
  }
  if (!entry.exec) {
    return { ok: false, errno: 'ENOSYS', message: 'sync-exec: exec is not available' };
  }
  const normalized = normalizeCommand(req);
  if ('errno' in normalized) {
    return { ok: false, errno: normalized.errno, message: normalized.message };
  }
  // Abort the in-flight `ctx.exec` at the budget so the command cannot outlive
  // the realm's blocked XHR and keep running with no consumer for its result.
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    clampSyncExecTimeout(req.timeoutMs, SYNC_EXEC_MAX_TIMEOUT_MS)
  );
  try {
    const result = await entry.exec(normalized.cmd, {
      cwd: entry.cwd,
      signal: controller.signal,
      ...(normalized.args !== undefined ? { args: normalized.args } : {}),
      ...(req.stdin !== undefined ? { stdin: req.stdin } : {}),
    });
    return {
      ok: true,
      kind: 'json',
      json: {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      } satisfies SyncExecResultPayload,
    };
  } catch (err) {
    // An aborted exec is a timeout, not a shell failure — surface it as
    // ETIMEDOUT so the shim can throw the Node-shaped timeout error.
    if (controller.signal.aborted) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, errno: 'ETIMEDOUT', message: `sync-exec: timed out — ${message}` };
    }
    // Shared with the fs channel so a sudo denial's EACCES survives rather than
    // being flattened to a generic EIO.
    return toErrno(err);
  } finally {
    clearTimeout(timer);
  }
}
