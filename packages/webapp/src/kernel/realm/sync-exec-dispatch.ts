import type { CommandContext } from 'just-bash';
import { toErrno } from './sync-fs-dispatch.js';
import { resolveSyncFsToken, trackSyncExec } from './sync-fs-token-registry.js';

import {
  SYNC_EXEC_CHANNEL,
  SYNC_EXEC_MAX_TIMEOUT_MS,
  type SyncExecRequest,
  type SyncExecResultPayload,
  type SyncFsRequest,
  type SyncFsResult,
} from './sync-fs-wire.js';

export {
  SYNC_EXEC_CHANNEL,
  type SyncExecRequest,
  type SyncExecRequestPayload,
  type SyncExecResultPayload,
} from './sync-fs-wire.js';

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

type ErrnoResult = { errno: string; message: string };

export async function resolveSyncExecCwd(
  fs: CommandContext['fs'],
  baseCwd: string,
  requested: unknown
): Promise<{ cwd: string } | ErrnoResult> {
  if (requested === undefined) return { cwd: baseCwd };
  if (typeof requested !== 'string') {
    return { errno: 'EINVAL', message: 'sync-exec: cwd must be a string' };
  }
  if (requested.length === 0) {
    return { errno: 'ENOENT', message: 'sync-exec: cwd is empty' };
  }
  const cwd = fs.resolvePath(baseCwd, requested);
  try {
    const st = await fs.stat(cwd);
    if (!st.isDirectory) {
      return { errno: 'ENOTDIR', message: `sync-exec: cwd is not a directory: ${cwd}` };
    }
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === 'EACCES' || code === 'EPERM') {
      return { errno: code, message: `sync-exec: cwd not accessible: ${cwd}` };
    }
    return { errno: 'ENOENT', message: `sync-exec: cwd does not exist: ${cwd}` };
  }
  return { cwd };
}

export function normalizeSyncExecEnv(
  env: unknown
): { ok: true; env: Record<string, string> } | ErrnoResult | undefined {
  if (env === undefined) return undefined;
  if (env === null || typeof env !== 'object' || Array.isArray(env)) {
    return { errno: 'EINVAL', message: 'sync-exec: env must be an object' };
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env as { [name: string]: string | undefined })) {
    if (value === undefined) continue;
    if (typeof value !== 'string') {
      return { errno: 'EINVAL', message: `sync-exec: env[${key}] must be a string` };
    }
    out[key] = value;
  }
  return { ok: true, env: out };
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
  const cwdResult = await resolveSyncExecCwd(entry.fs, entry.cwd, req.cwd);
  if ('errno' in cwdResult) {
    return { ok: false, errno: cwdResult.errno, message: cwdResult.message };
  }
  const envResult = normalizeSyncExecEnv(req.env);
  if (envResult !== undefined && 'errno' in envResult) {
    return { ok: false, errno: envResult.errno, message: envResult.message };
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
      cwd: cwdResult.cwd,
      signal: controller.signal,
      ...(normalized.args !== undefined ? { args: normalized.args } : {}),
      ...(req.stdin !== undefined ? { stdin: req.stdin } : {}),
      ...(envResult !== undefined ? { env: envResult.env, replaceEnv: true } : {}),
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
