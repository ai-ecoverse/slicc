import { type SyncFsRequest, type SyncFsResult, toErrno } from './sync-fs-dispatch.js';
import { resolveSyncFsToken, trackSyncExec } from './sync-fs-token-registry.js';
import { SYNC_EXEC_MAX_TIMEOUT_MS } from './sync-fs-wire.js';

export const SYNC_EXEC_CHANNEL = 'exec';

export interface SyncExecRequestPayload {
  command: string | string[];

  args?: string[];

  stdin?: string;

  timeoutMs?: number;
}

export interface SyncExecRequest extends SyncExecRequestPayload {
  token: string;
  channel: typeof SYNC_EXEC_CHANNEL;
}

export interface SyncExecResultPayload {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function isSyncExecRequest(req: SyncFsRequest | SyncExecRequest): req is SyncExecRequest {
  return (req as SyncExecRequest).channel === SYNC_EXEC_CHANNEL;
}

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

export function clampSyncExecTimeout(timeoutMs: number | undefined, fallbackMs: number): number {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Math.min(fallbackMs, SYNC_EXEC_MAX_TIMEOUT_MS);
  }
  return Math.min(timeoutMs, SYNC_EXEC_MAX_TIMEOUT_MS);
}

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

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(
    () => {
      timedOut = true;
      controller.abort();
    },
    clampSyncExecTimeout(req.timeoutMs, SYNC_EXEC_MAX_TIMEOUT_MS)
  );

  const untrack = trackSyncExec(req.token, controller);
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
    if (timedOut) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, errno: 'ETIMEDOUT', message: `sync-exec: timed out — ${message}` };
    }

    if (controller.signal.aborted) {
      return { ok: false, errno: 'ECANCELED', message: 'sync-exec: realm disposed' };
    }

    return toErrno(err);
  } finally {
    clearTimeout(timer);
    untrack();
  }
}
