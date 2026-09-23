import {
  clampSyncExecTimeout,
  SYNC_EXEC_CHANNEL,
  type SyncExecRequestPayload,
  type SyncExecResultPayload,
} from './sync-exec-dispatch.js';
import type { SyncFsCache } from './sync-fs-cache.js';
import {
  SYNC_EXEC_DEFAULT_TIMEOUT_MS,
  SYNC_EXEC_ROUTE,
  SYNC_EXEC_XHR_MARGIN_MS,
} from './sync-fs-wire.js';
import type { SyncFsXhrMutatingBridge } from './sync-fs-xhr-bridge.js';
import { synchronifyJson, syncXhrError } from './sync-xhr.js';

export interface SyncExecOptions {
  args?: string[];

  input?: string;

  timeout?: number;

  cwd?: string;

  env?: Record<string, string>;
}

export interface SyncExecXhrBridge {
  run(command: string | string[], opts?: SyncExecOptions): SyncExecResultPayload;
}

export type SyncExecTransport = (
  payload: SyncExecRequestPayload,
  timeoutMs: number,
  label: string
) => SyncExecResultPayload;

function xhrExecTransport(token: string): SyncExecTransport {
  return (payload, timeoutMs, label) => {
    const json = synchronifyJson({
      method: 'POST',
      url: SYNC_EXEC_ROUTE,
      token,
      body: new TextEncoder().encode(JSON.stringify({ ...payload, channel: SYNC_EXEC_CHANNEL })),

      timeoutMs: timeoutMs + SYNC_EXEC_XHR_MARGIN_MS,
      label,
    }) as Partial<SyncExecResultPayload> | null;
    if (
      !json ||
      typeof json.stdout !== 'string' ||
      typeof json.stderr !== 'string' ||
      typeof json.exitCode !== 'number'
    ) {
      throw syncXhrError('EIO', label);
    }
    return { stdout: json.stdout, stderr: json.stderr, exitCode: json.exitCode };
  };
}

export function flushBeforeSyncExec(syncFs: SyncFsCache, fsBridge: SyncFsXhrMutatingBridge): void {
  const mutations = syncFs.getMutations();

  for (const path of mutations.deleted) fsBridge.rm(path);
  for (const entry of mutations.created) {
    if (entry.isDirectory) fsBridge.mkdir(entry.path);
    else fsBridge.writeFile(entry.path, entry.content);
  }
  for (const entry of mutations.modified) fsBridge.writeFile(entry.path, entry.content);
  syncFs.resetBaseline();
}

export function createSyncExecXhrBridge(
  token: string,
  opts: {
    syncFs?: SyncFsCache;
    fsBridge?: SyncFsXhrMutatingBridge;
    timeoutMs?: number;

    transport?: SyncExecTransport;
  } = {}
): SyncExecXhrBridge {
  const defaultTimeoutMs = opts.timeoutMs ?? SYNC_EXEC_DEFAULT_TIMEOUT_MS;
  const { syncFs, fsBridge } = opts;
  const transport = opts.transport ?? xhrExecTransport(token);

  return {
    run(command: string | string[], runOpts: SyncExecOptions = {}): SyncExecResultPayload {
      const coherent = syncFs?.wasUsed() === true && fsBridge !== undefined;
      if (coherent) flushBeforeSyncExec(syncFs!, fsBridge!);
      const label = `sync-exec bridge, '${Array.isArray(command) ? command.join(' ') : command}'`;

      const timeoutMs = clampSyncExecTimeout(runOpts.timeout, defaultTimeoutMs);
      const payload: SyncExecRequestPayload = {
        command,
        ...(runOpts.args !== undefined ? { args: runOpts.args } : {}),
        ...(runOpts.input !== undefined ? { stdin: runOpts.input } : {}),
        ...(runOpts.cwd !== undefined ? { cwd: runOpts.cwd } : {}),
        ...(runOpts.env !== undefined ? { env: runOpts.env } : {}),
        timeoutMs,
      };
      try {
        return transport(payload, timeoutMs, label);
      } finally {
        if (coherent) syncFs!.invalidate();
      }
    },
  };
}
