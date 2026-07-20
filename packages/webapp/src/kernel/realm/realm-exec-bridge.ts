/**
 * `realm-exec-bridge.ts` — the realm's `exec` bridge: buffered-stdin,
 * killable spawn handles made coherent with the synchronous fs cache via a
 * flush/resnapshot dance. Extracted from `js-realm-shared.ts`; no behavior
 * change.
 */
import type { RealmRpcClient } from './realm-rpc.js';
import type { SyncFsCache, SyncFsSnapshot } from './sync-fs-cache.js';

export type ExecResult = { stdout: string; stderr: string; exitCode: number };

/** Options for the buffered-stdin, killable `exec.start` spawn handle. */
export type ExecStartOptions = {
  /** Fallback stdin buffer; used only when no `stdin.write()` chunks were buffered (chunks win). */
  stdin?: string;
  /** Shape of `stdin` — matches just-bash `CommandExecOptions.stdinKind`. */
  stdinKind?: 'text' | 'bytes';
  /** Shell-free argv tail (string command form only; array form uses its own tail). */
  args?: string[];
};

/**
 * Handle returned by `exec.start`. Deferred-start, buffered-stdin, killable:
 * `stdin.write` buffers, `stdin.end()` launches the command via the
 * `exec:start` op (resolving `done` with the buffered result), and `kill`
 * fans a signal out via `exec:kill`. The substrate a `child_process`
 * polyfill needs. NOT interactive/streaming (just-bash is one-shot buffered).
 */
export type ExecHandle = {
  kill(sig?: string): Promise<boolean>;
  stdin: { write(chunk: string): void; end(): void };
  done: Promise<ExecResult>;
};

export type ExecBridge = ((cmd: string) => Promise<ExecResult>) & {
  spawn: (argv: string[]) => Promise<ExecResult>;
  exec: (cmd: string) => Promise<ExecResult>;
  start: (commandOrArgv: string | string[], opts?: ExecStartOptions) => ExecHandle;
};

/** POSIX 128+signum exit code for a client-side pre-start kill (matches the host). */
function killExitCode(sig?: string): number {
  if (sig === 'SIGKILL') return 137;
  if (sig === 'SIGINT') return 130;
  return 143; // SIGTERM (default) and any other terminating signal
}

/**
 * Build the `exec` bridge, made COHERENT with the realm's synchronous fs cache
 * within a single script. `exec` runs the host shell directly against the real
 * VFS, so without coordination a `writeFileSync` earlier in the script (still
 * sitting in {@link SyncFsCache}) would be invisible to the shell, and a file
 * the shell creates would be invisible to a later `readFileSync` (the cache is
 * snapshotted once at boot). Every exec op therefore does:
 *
 *   1. FLUSH pending sync-fs mutations to the host (`vfs.flushWrites`) BEFORE
 *      dispatch, so the shell sees them — then reset the cache's mutation
 *      baseline so those writes are not re-applied later (see `resetBaseline`).
 *   2. run the exec.
 *   3. RE-SNAPSHOT the host (`vfs.snapshot`) AFTER the exec resolves and
 *      `applySnapshot` it, so a subsequent `readFileSync` sees the exec's
 *      changes.
 *
 * Perf gate: both round-trips are skipped unless `syncFs.wasUsed()` — an
 * exec-only or async-only script never touches the sync cache, so it keeps the
 * pre-existing fast path with zero extra RPCs.
 */
export function createExecBridge(
  rpc: RealmRpcClient,
  syncFs?: SyncFsCache,
  cwd?: string,
  writeStderr?: (value: unknown) => void
): ExecBridge {
  // FLUSH-before: push the sync cache's pending mutations to the host so the
  // shell about to run sees them, then reset the baseline so the end-of-script
  // flush (or the next exec) doesn't re-apply the same writes. No-op — and no
  // RPC — when there is no sync cache (RPC-only unit tests) or the sync-fs API
  // was never used.
  const flushBeforeExec = async (): Promise<void> => {
    if (!syncFs?.wasUsed()) return;
    const mutations = syncFs.getMutations();
    if (mutations.created.length || mutations.modified.length || mutations.deleted.length) {
      await rpc.call('vfs', 'flushWrites', [mutations]);
    }
    syncFs.resetBaseline();
  };

  // RE-SNAPSHOT-after: pull fresh host state so a later `readFileSync` sees
  // what the exec wrote. Same perf gate. A snapshot failure leaves the cache
  // as-is rather than crashing the script. `preserveMutations` is set by the
  // `start` (killable spawn) path, where user code keeps running during the
  // background spawn: sync writes made in that window live only in the cache
  // and must survive the re-snapshot (see `applySnapshotPreservingMutations`).
  // `run`/`spawn` suspend user code across the await, so no interleaving and
  // the plain `applySnapshot` (discard) is correct for them.
  const resnapshotAfterExec = async (preserveMutations = false): Promise<void> => {
    if (!syncFs?.wasUsed()) return;
    try {
      const snapshot = await rpc.call<SyncFsSnapshot>('vfs', 'snapshot', [cwd]);
      if (preserveMutations) syncFs.applySnapshotPreservingMutations(snapshot);
      else syncFs.applySnapshot(snapshot);
    } catch (err) {
      // Keep the pre-exec cache view, but SURFACE the failure: a silently
      // swallowed re-snapshot means a later readFileSync of an exec-touched
      // path can return stale cache bytes with no signal. Mirror the
      // flushSyncFsCache stderr breadcrumb so the staleness is diagnosable.
      const msg = err instanceof Error ? err.message : String(err);
      writeStderr?.(`[sync-fs] re-snapshot after exec failed: ${msg}\n`);
    }
  };

  const execRun = async (command: string): Promise<ExecResult> => {
    await flushBeforeExec();
    try {
      return await rpc.call<ExecResult>('exec', 'run', [command]);
    } finally {
      await resnapshotAfterExec();
    }
  };

  const spawn = async (argv: string[]): Promise<ExecResult> => {
    await flushBeforeExec();
    try {
      return await rpc.call<ExecResult>('exec', 'spawn', [argv]);
    } finally {
      await resnapshotAfterExec();
    }
  };

  // Client-side monotonic spawn id. The host keys its live-spawn map off
  // this, so `kill` can address the exact in-flight command.
  let nextSpawnId = 1;

  const start = (commandOrArgv: string | string[], opts?: ExecStartOptions): ExecHandle => {
    const spawnId = nextSpawnId++;
    const chunks: string[] = [];
    let started = false;
    // Re-entrancy guard: `fire()` is async (it awaits `flushBeforeExec()`
    // before the host learns the spawnId), so a second `stdin.end()` — or a
    // `kill()` racing the flush window — must not double-launch. `started`
    // flips only AFTER the flush, so it can't cover this window on its own.
    let firing = false;
    // A `kill()` before `stdin.end()` can't reach the host (the spawnId
    // isn't registered until `exec:start` arrives), so honor it client-side.
    let killed = false;
    let resolveDone!: (value: ExecResult) => void;
    let rejectDone!: (error: unknown) => void;
    const done = new Promise<ExecResult>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    const fire = (): void => {
      // A pre-start `kill()` wins: never launch a spawn that was already killed.
      if (started || killed) return;
      // Already launching (flush in flight): don't dispatch `exec:start` twice.
      if (firing) return;
      firing = true;
      // Buffered `stdin.write` chunks win; fall back to an upfront
      // `opts.stdin`. `undefined` means "no stdin" (empty on the host).
      const buffered = chunks.length > 0 ? chunks.join('') : opts?.stdin;
      const startOpts: ExecStartOptions = {};
      if (buffered !== undefined) startOpts.stdin = buffered;
      if (opts?.stdinKind !== undefined) startOpts.stdinKind = opts.stdinKind;
      if (opts?.args !== undefined) startOpts.args = opts.args;
      // Flush-before / re-snapshot-after wrap the killable spawn too: flush
      // before the `exec:start` dispatch, re-snapshot after `done` resolves.
      // The re-snapshot PRESERVES sync writes made while the spawn was in
      // flight (user code kept running) — see resnapshotAfterExec.
      void (async () => {
        try {
          await flushBeforeExec();
          // A `kill()` arrived during the flush window: the host never
          // received `exec:start` (spawnId still unregistered), so keep the
          // command client-side and never dispatch it. `kill()` already
          // resolved `done` as terminated.
          if (killed) {
            await resnapshotAfterExec(true);
            return;
          }
          // Only now is the host about to register the spawnId, so a later
          // `kill()` can safely fan out over `exec:kill`.
          started = true;
          const result = await rpc.call<ExecResult>('exec', 'start', [
            spawnId,
            commandOrArgv,
            startOpts,
          ]);
          await resnapshotAfterExec(true);
          resolveDone(result);
        } catch (err: unknown) {
          await resnapshotAfterExec(true);
          rejectDone(err);
        }
      })();
    };
    return {
      kill: (sig?: string): Promise<boolean> => {
        // Post-start: the host knows the spawnId, so fan the signal out.
        if (started) return rpc.call('exec', 'kill', [spawnId, sig]);
        // Pre-start OR firing-but-not-yet-registered: an `exec:kill` would
        // race ahead of `exec:start` and be dropped by the host, then
        // `fire()` would still launch. Honor it client-side — mark killed so
        // `fire()` aborts the dispatch and resolve `done` as terminated.
        killed = true;
        resolveDone({ stdout: '', stderr: '', exitCode: killExitCode(sig) });
        return Promise.resolve(true);
      },
      stdin: {
        write: (chunk: string): void => {
          // Post-launch (or post-kill) writes are dropped — just-bash takes a
          // single upfront buffer, so there's no interactive stdin to write to.
          if (!started && !killed) chunks.push(chunk);
        },
        end: (): void => fire(),
      },
      done,
    };
  };

  const execBridge = Object.assign(execRun, {
    spawn,
    start,
  }) as ExecBridge;
  execBridge.exec = execBridge;
  return execBridge;
}
