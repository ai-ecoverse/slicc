import { type SyncFsRequest, type SyncFsResult, toErrno } from './sync-fs-dispatch.js';
import { resolveSyncFsToken, trackSyncExec } from './sync-fs-token-registry.js';
import { SYNC_EXEC_MAX_TIMEOUT_MS } from './sync-fs-wire.js';

export const SYNC_EXEC_CHANNEL = 'exec';

export interface SyncExecRequestPayload {
  command: string | string[];

  args?: string[];

  stdin?: string;

  timeoutMs?: number;

  cwd?: string;

  env?: Record<string, string>;
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

function normalizeCwd(
  cwd: unknown,
  fallback: string
): { cwd: string } | { errno: string; message: string } {
  if (cwd === undefined) return { cwd: fallback };
  if (typeof cwd !== 'string' || cwd.length === 0) {
    return { errno: 'EINVAL', message: 'sync-exec: cwd must be a non-empty string' };
  }
  return { cwd };
}

type EnvBag = { [key: string]: string | undefined };

function normalizeEnv(
  env: unknown
): { env?: Record<string, string> } | { errno: string; message: string } {
  if (env === undefined) return {};
  if (env === null || typeof env !== 'object' || Array.isArray(env)) {
    return { errno: 'EINVAL', message: 'sync-exec: env must be a string record' };
  }
  const bag = env as EnvBag;
  const out: Record<string, string> = {};
  for (const key of Object.keys(bag)) {
    const value = bag[key];
    if (value === undefined) continue;
    if (typeof value !== 'string') {
      return { errno: 'EINVAL', message: 'sync-exec: env values must be strings' };
    }
    out[key] = value;
  }
  return { env: out };
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
  const cwd = normalizeCwd(req.cwd, entry.cwd);
  if ('errno' in cwd) {
    return { ok: false, errno: cwd.errno, message: cwd.message };
  }
  const env = normalizeEnv(req.env);
  if ('errno' in env) {
    return { ok: false, errno: env.errno, message: env.message };
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
      cwd: cwd.cwd,
      signal: controller.signal,
      ...(normalized.args !== undefined ? { args: normalized.args } : {}),
      ...(req.stdin !== undefined ? { stdin: req.stdin } : {}),
      ...(env.env !== undefined ? { env: env.env, replaceEnv: true } : {}),
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
