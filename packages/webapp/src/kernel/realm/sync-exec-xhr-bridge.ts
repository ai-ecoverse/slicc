/**
 * Realm-side client for the synchronous-exec bridge — the substrate under
 * `child_process.execSync` / `execFileSync` / `spawnSync`.
 *
 * Issues one blocking round-trip (see `sync-xhr.ts`) to `/__slicc/exec-sync`
 * carrying a JSON command envelope; the controlling Service Worker forwards it
 * to the kernel-worker responder, which runs the command through the CALLING
 * realm's own `ctx.exec` — same sudo command guard, path ACLs, and secret
 * masking as the async `exec` RPC. The realm worker blocks meanwhile; the sudo
 * brokers live in the kernel worker / page, so an approval prompt still renders
 * and resolves while it does.
 *
 * **Coherence with the sync fs cache.** The async exec bridge does
 * flush-before / re-snapshot-after (`realm-exec-bridge.ts`). Neither await is
 * available here, so this bridge instead:
 *
 *   1. FLUSHES pending {@link SyncFsCache} mutations over the *fs* bridge
 *      (blocking writes / mkdir / rm), so the command sees them, then rebases
 *      the cache's mutation baseline so the end-of-script flush doesn't
 *      re-apply them.
 *   2. runs the command.
 *   3. INVALIDATES the cache rather than re-snapshotting: a fresh snapshot
 *      cannot be pulled through a blocking XHR cheaply, and every sync read
 *      already falls through to the live fs bridge on a cache miss — so
 *      dropping the stale entries is both correct and far cheaper.
 *
 * Both steps are skipped entirely unless the script has actually touched
 * sync-fs (`wasUsed()`), matching the async bridge's perf gate.
 */

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

/** Options accepted by one synchronous exec. */
export interface SyncExecOptions {
  /** Shell-free argv tail for the string command form. */
  args?: string[];
  /** Buffered stdin for the one-shot command. */
  input?: string;
  /** Caller budget in ms; clamped server-side to the wire ceiling. */
  timeout?: number;
}

export interface SyncExecXhrBridge {
  run(command: string | string[], opts?: SyncExecOptions): SyncExecResultPayload;
}

/**
 * One blocking exec round-trip. The default is the sync-XHR → SW route; the
 * Atomics/SAB fast path (`sync-sab-bridge.ts`) supplies its own. Either way
 * the envelope is the same `SyncExecRequestPayload`, so `dispatchSyncExec`
 * cannot tell the transports apart. Must throw an errno `Error` on any
 * transport or dispatch failure and return only a well-formed payload.
 */
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
      // Give the transport a margin over the command budget so the SW's
      // authoritative errno wins the race with the bare XHR-timeout EIO —
      // same ordering the fs channel relies on.
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

/**
 * Push the cache's pending mutations to the live VFS over the blocking fs
 * bridge, then rebase the baseline so the end-of-script flush doesn't reapply
 * them. Mirrors `createExecBridge`'s `flushBeforeExec`, minus the `await`.
 */
function flushBeforeSyncExec(syncFs: SyncFsCache, fsBridge: SyncFsXhrMutatingBridge): void {
  const mutations = syncFs.getMutations();
  // Order matches `applySyncFsMutations`: a path deleted then recreated with a
  // different type must tear the old node down before the new one is written.
  for (const path of mutations.deleted) fsBridge.rm(path);
  for (const entry of mutations.created) {
    if (entry.isDirectory) fsBridge.mkdir(entry.path);
    else fsBridge.writeFile(entry.path, entry.content);
  }
  for (const entry of mutations.modified) fsBridge.writeFile(entry.path, entry.content);
  syncFs.resetBaseline();
}

/**
 * Build the synchronous exec bridge. `syncFs` + `fsBridge` are the coherence
 * pair — both must be present for the flush/invalidate dance; without them the
 * bridge still runs commands (an exec-only script needs no coherence).
 */
export function createSyncExecXhrBridge(
  token: string,
  opts: {
    syncFs?: SyncFsCache;
    fsBridge?: SyncFsXhrMutatingBridge;
    timeoutMs?: number;
    /** Blocking transport; defaults to the sync-XHR → SW route bound to `token`. */
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
      // Clamp HERE, not just server-side: the transport budget below derives
      // from this value, so an unclamped one desyncs the two. Node's
      // `{ timeout: 0 }` means "no timeout" and must become the default budget
      // (the SW's own fallback) rather than a 0 that makes the XHR give up in
      // SYNC_EXEC_XHR_MARGIN_MS; an oversized one must hit the wire ceiling
      // here too, or the XHR waits long past the command the SW already killed.
      const timeoutMs = clampSyncExecTimeout(runOpts.timeout, defaultTimeoutMs);
      const payload: SyncExecRequestPayload = {
        command,
        ...(runOpts.args !== undefined ? { args: runOpts.args } : {}),
        ...(runOpts.input !== undefined ? { stdin: runOpts.input } : {}),
        timeoutMs,
      };
      try {
        return transport(payload, timeoutMs, label);
      } finally {
        // INVALIDATE (not re-snapshot): the command may have changed anything
        // under the cache, and every sync read falls through to the live fs
        // bridge on a miss. Runs even when the exec threw — a failed command
        // can still have written before it died.
        if (coherent) syncFs!.invalidate();
      }
    },
  };
}
