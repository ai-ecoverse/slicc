/**
 * `realm-runner.ts` — generalized hard-killable runner for `node`,
 * `.jsh`, and `python` execution. Replaces `preemptive-runner.ts`
 * by adding kernel-side RPC for VFS / exec / fetch and pluggable
 * realm transports.
 *
 * Lifecycle (mirrors the preemptive runner with two changes):
 *   1. `pm.spawn({ kind, argv, owner, ppid })` — process record.
 *   2. `realmFactory({ kind, ctx })` → `{ realm }` — creates a
 *      `DedicatedWorker` (standalone JS, both modes Python) or a
 *      per-task sandbox iframe (extension JS).
 *   3. `attachRealmHost(realm.controlPort, ctx)` — wires
 *      `vfs`/`exec`/`fetch` RPC against the caller's context.
 *   4. `realm.controlPort.postMessage(realm-init)` — kicks off
 *      execution in the realm.
 *   5. Resolve on `realm-done` (with the script's exit code) /
 *      `realm-error` (exit 1, message to stderr) / SIGKILL (exit
 *      137 + `realm.terminate()`). Streamed `realm-output` and
 *      `realm-fs-write` posts are applied as they arrive so a kill
 *      still returns pre-hang stdout and completed sync writes
 *      (#3136).
 *
 * Signal contract: realm code is opaque (no cooperative cancel
 * hook), so every terminating signal that reaches the realm pid is
 * escalated to a synchronous `realm.terminate()` — SIGKILL (137),
 * SIGTERM (143), and SIGINT (130). This is what lets a terminal
 * Ctrl-C or `kill <pid>` (fanned out from the shell parent by
 * `ProcessManager.signal`) actually stop the job (#1116). SIGSTOP /
 * SIGCONT are pause/resume, not termination, and are ignored here.
 *
 * Worker-termination during in-flight VFS write / fetch is
 * acceptable: SIGKILL is uncatchable POSIX-style. Partial writes
 * to VFS or aborted fetches mid-flight are an existing risk in
 * the kernel-realm path too — the realm runtime doesn't make this
 * worse.
 */

import type { CommandContext } from 'just-bash';
import type { ProcessKind, ProcessManager, ProcessOwner } from '../process-manager.js';
import { attachRealmHost, type RealmHostHandle } from './realm-host.js';
import type { RealmPortLike } from './realm-rpc.js';
import type {
  RealmDoneMsg,
  RealmErrorMsg,
  RealmFsDeleteMsg,
  RealmFsWriteMsg,
  RealmInitMsg,
  RealmKind,
  RealmMountPoint,
  RealmOutputMsg,
} from './realm-types.js';
import { isSyncSabSupported, SAB_DEFAULT_WINDOW_BYTES, SAB_HEADER_BYTES } from './sync-sab-wire.js';

// ---------------------------------------------------------------------------
// Realm abstraction
// ---------------------------------------------------------------------------

/**
 * A live realm. Wraps either a `DedicatedWorker` or a per-task
 * sandbox iframe. The runner only needs `controlPort` to drive the
 * init/done protocol and `terminate()` for SIGKILL.
 */
export interface Realm {
  /** RPC and control message port. */
  readonly controlPort: RealmPortLike;
  /** Synchronous hard-stop. Idempotent. */
  terminate(): void;
  /**
   * `true` when the realm executes on its OWN thread (a `DedicatedWorker`),
   * i.e. it may block in `Atomics.wait` without stalling the kernel. Only such
   * realms get the SharedArrayBuffer sync bridge (#2043); the in-process test
   * factory leaves this unset and keeps the SW / snapshot paths — a blocking
   * wait on the kernel thread would deadlock against its own responder.
   */
  readonly isolatedThread?: boolean;
  /**
   * Optional: kernel-host can subscribe to abnormal realm ends. `error`
   * fires on an uncaught bootstrap error / worker crash; `messageerror`
   * fires when the realm posted a message the host could not deserialize
   * (structured-clone failure — typically a worker that died mid-post).
   * Both must settle the run non-zero so a dead worker never degrades to
   * exit 0 or hangs.
   */
  addEventListener?: (
    type: 'error' | 'messageerror',
    handler: (event: Event) => void,
    options?: AddEventListenerOptions
  ) => void;
  removeEventListener?: (type: 'error' | 'messageerror', handler: (event: Event) => void) => void;
}

export interface RealmFactoryArgs {
  kind: RealmKind;
  ctx: CommandContext;
}

export type RealmFactory = (args: RealmFactoryArgs) => Promise<Realm>;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RunInRealmOptions {
  pm: ProcessManager;
  realmFactory: RealmFactory;
  owner: ProcessOwner;
  kind: RealmKind;
  /** Source code: JS for `kind:'js'`, Python for `kind:'py'`. */
  code: string;
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  filename: string;
  ctx: CommandContext;
  ppid?: number;
  /**
   * Override the argv exposed to user code as `process.argv` (JS) or
   * `sys.argv` (py). When omitted, `argv` is used for both the
   * `ps` display and the realm init message. Python uses this to
   * separate the human-friendly process record (`python3 -c CODE …`)
   * from the POSIX-correct `sys.argv` (`['-c', …userArgs]`).
   */
  realmArgv?: string[];
  /** Optional initial stdin exposed to the user code. */
  stdin?: string;
  /** Pyodide indexURL — only consumed when `kind:'py'`. */
  pyodideIndexURL?: string;
  /**
   * Absolute VFS path of an ipk-installed pyodide package — only
   * consumed when `kind:'py'`. Forwarded to
   * {@link RealmInitMsg.pyodideAssetRoot}; see that field for the
   * full standalone-only VFS-bytes loader contract.
   */
  pyodideAssetRoot?: string;
  /** Pyodide VFS sync directories — only consumed when `kind:'py'`. */
  pyodideMountDirs?: string[];
  /**
   * Forwarded to `RealmInitMsg.opfsMountDbName`. Always set to
   * `'slicc-fs'` by the Python command — the Python realm worker
   * uses `pyodide.FS.mount(OPFS_SYNC_FS, …)`
   * against the same OPFS subtree the kernel worker owns — the
   * in-tree plugin builds the FS tree synchronously from a prewalk
   * snapshot and queues OPFS mutations, which are drained via
   * `flushOpfsRealmMounts` before `realm-done`.
   */
  opfsMountDbName?: string;
  /**
   * Forwarded to `RealmInitMsg.mountPoints` — VFS mount points
   * overlapping {@link pyodideMountDirs}. The Python realm worker
   * overlays a throwing FS plugin at each path so any synchronous
   * access from Python raises an OSError pointing at the async
   * `slicc.fs` module. Only consumed when `kind:'py'`.
   */
  mountPoints?: RealmMountPoint[];
  /**
   * Override the `ProcessKind` used to register the process. Defaults
   * to `'jsh'` (Python migration overrides this with `'py'` once the
   * union is widened).
   */
  procKind?: ProcessKind;
  /**
   * Enable the synchronous-fs SW bridge for this realm. Threaded into
   * `attachRealmHost` (which mints the capability token) and, when set,
   * copies the minted `host.syncFsToken` into the realm's `RealmInitMsg`.
   * Set by the kernel host only when the page has confirmed a controlling
   * Service Worker (see the plan's binding correction 2); default off keeps
   * today's snapshot behavior and is what the in-process test factory uses.
   */
  syncFsBridgeEnabled?: boolean;
  /**
   * Payload window size for the Atomics/SAB sync bridge (#2043); default
   * `SAB_DEFAULT_WINDOW_BYTES`. Tests shrink it to exercise chunking.
   */
  syncSabBytes?: number;
}

export interface RealmResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const SIGNAL_EXIT_CODE = { SIGKILL: 137, SIGINT: 130, SIGTERM: 143 } as const;

/**
 * Trailer appended to stderr when the realm is torn down by a terminating
 * signal rather than `realm-done`. Matches the bash-job `#2415` shape so a
 * `timeout` kill is diagnosable even when the script printed nothing.
 */
export function realmKilledTrailer(elapsedMs: number, exitCode: number): string {
  const seconds = Math.max(0, elapsedMs) / 1000;
  const shown =
    seconds < 10
      ? seconds
          .toFixed(2)
          .replace(/(\.\d*?)0+$/, '$1')
          .replace(/\.$/, '')
      : String(Math.round(seconds));
  return `--- killed after ${shown}s (exit ${exitCode}) ---\n`;
}

type PendingFsOp =
  | { op: 'write'; path: string; bytes: Uint8Array }
  | { op: 'delete'; path: string };

/** Live stdout/stderr + coalesced host VFS mutations streamed from the realm (#3136). */
interface LiveRealmCapture {
  stdout: string;
  stderr: string;
  /** Latest write/delete per path — appends replace, so the buffer stays O(paths). */
  pendingByPath: Map<string, PendingFsOp>;
}

function dropPendingPaths(capture: LiveRealmCapture, paths: readonly string[]): void {
  for (const path of paths) capture.pendingByPath.delete(path);
}

/** Apply fire-and-forget live posts. Returns whether the message settles the run. */
function ingestLiveRealmMessage(
  data: { type?: string },
  capture: LiveRealmCapture
): 'done' | 'error' | 'live' {
  if (data.type === 'realm-output') {
    const msg = data as RealmOutputMsg;
    if (msg.stream === 'stdout') capture.stdout += msg.chunk;
    else capture.stderr += msg.chunk;
    return 'live';
  }
  if (data.type === 'realm-fs-write') {
    const msg = data as RealmFsWriteMsg;
    capture.pendingByPath.set(msg.path, { op: 'write', path: msg.path, bytes: msg.bytes });
    return 'live';
  }
  if (data.type === 'realm-fs-delete') {
    const msg = data as RealmFsDeleteMsg;
    capture.pendingByPath.set(msg.path, { op: 'delete', path: msg.path });
    return 'live';
  }
  if (data.type === 'realm-done') return 'done';
  if (data.type === 'realm-error') return 'error';
  return 'live';
}

async function applyPendingFsOp(
  ctx: CommandContext,
  op: PendingFsOp,
  capture: LiveRealmCapture
): Promise<void> {
  try {
    if (op.op === 'write') {
      const writeFile = ctx.fs?.writeFile?.bind(ctx.fs);
      if (writeFile) await writeFile(op.path, op.bytes);
    } else {
      const rm = ctx.fs?.rm?.bind(ctx.fs);
      if (rm) await rm(op.path, { recursive: true });
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const kind = op.op === 'write' ? 'write' : 'delete';
    capture.stderr += `[sync-fs] ERROR: ${kind} of ${op.path} was NOT persisted: ${msg}\n`;
  }
}

async function applyCapturedFsOps(
  ops: readonly PendingFsOp[],
  ctx: CommandContext,
  capture: LiveRealmCapture
): Promise<void> {
  for (const op of ops) await applyPendingFsOp(ctx, op, capture);
}

function buildRealmInitMsg(
  opts: RunInRealmOptions,
  host: RealmHostHandle,
  syncSab: SharedArrayBuffer | undefined
): RealmInitMsg {
  return {
    type: 'realm-init',
    kind: opts.kind,
    code: opts.code,
    argv: opts.realmArgv ?? opts.argv,
    env: opts.env,
    cwd: opts.cwd,
    filename: opts.filename,
    stdin: opts.stdin,
    pyodideIndexURL: opts.pyodideIndexURL,
    pyodideAssetRoot: opts.pyodideAssetRoot,
    pyodideMountDirs: opts.pyodideMountDirs,
    opfsMountDbName: opts.opfsMountDbName,
    mountPoints: opts.mountPoints,
    ...(host.syncFsToken !== undefined ? { syncFsToken: host.syncFsToken } : {}),
    ...(syncSab ? { syncSab } : {}),
  };
}

/**
 * Run `code` in a fresh realm of `kind`, hooking the resulting
 * process into `pm` so `ps` / `kill` see it. Resolves with
 * stdout/stderr/exit-code on natural completion or 137 on SIGKILL.
 */
export async function runInRealm(opts: RunInRealmOptions): Promise<RealmResult> {
  const procKind: ProcessKind = opts.procKind ?? 'jsh';
  const proc = opts.pm.spawn({
    kind: procKind,
    argv: opts.argv,
    cwd: opts.cwd,
    env: opts.env,
    owner: opts.owner,
    ppid: opts.ppid,
  });

  let realm: Realm;
  try {
    realm = await opts.realmFactory({ kind: opts.kind, ctx: opts.ctx });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    opts.pm.exit(proc.pid, 1);
    return { stdout: '', stderr: `realm-runner: ${message}\n`, exitCode: 1 };
  }

  // Stamp `scoopJid` onto the host so the `wsObserve` op can tag
  // every subscriber with its owning scoop. Without this thread,
  // `Orchestrator.unregisterScoop → dropForScoop(jid)` matches no
  // subscribers and page routers keep forwarding after the scoop is
  // gone. The owner record is the single trusted source.
  // Thread the PM + owner + realm pid so the `exec.start` / `exec.kill` ops
  // register each realm-spawned command as a real PM process (parented to
  // THIS realm's pid, so a signal to the realm fans out to its children)
  // and a `kill` op can signal it. See `realm-host.ts` dispatchExecStart.
  // Atomics/SAB fast path (#2043): on a cross-origin-isolated leader a realm
  // that owns its thread gets a shared buffer and blocks on it directly —
  // no Service Worker in the loop, so the SW-confirmation gate
  // (`syncFsBridgeEnabled`) is not required to mint its token. Everywhere
  // else the SW transport (when confirmed) or the snapshot remains.
  const syncSab = realm.isolatedThread ? allocateSyncSab(opts.syncSabBytes) : undefined;
  const capture: LiveRealmCapture = { stdout: '', stderr: '', pendingByPath: new Map() };
  const host: RealmHostHandle = attachRealmHost(realm.controlPort, opts.ctx, {
    ...(opts.owner.scoopJid !== undefined ? { scoopJid: opts.owner.scoopJid } : {}),
    pm: opts.pm,
    owner: opts.owner,
    ppid: proc.pid,
    syncFsBridgeEnabled: Boolean(opts.syncFsBridgeEnabled) || syncSab !== undefined,
    ...(syncSab ? { syncSab } : {}),
    onHostFsMutation: (paths) => dropPendingPaths(capture, paths),
  });

  return new Promise<RealmResult>((resolve) => {
    let settling = false;
    let stopped = false;
    let unsubSignal: (() => void) | null = null;
    let messageHandler: ((event: MessageEvent) => void) | null = null;
    let errorHandler: ((event: Event) => void) | null = null;
    let messageErrorHandler: ((event: Event) => void) | null = null;

    const hardStop = (): void => {
      if (stopped) return;
      stopped = true;
      if (messageHandler) realm.controlPort.removeEventListener('message', messageHandler);
      if (realm.removeEventListener) {
        if (errorHandler) realm.removeEventListener('error', errorHandler);
        if (messageErrorHandler) realm.removeEventListener('messageerror', messageErrorHandler);
      }
      unsubSignal?.();
      try {
        realm.terminate();
      } catch {
        /* idempotent on real workers / iframes */
      }
    };

    const finish = (result: RealmResult, exitForPm: number | null): void => {
      hardStop();
      host.dispose();
      opts.pm.exit(proc.pid, exitForPm);
      resolve(result);
    };

    const settleDone = (result: RealmResult, exitForPm: number | null): void => {
      if (settling) return;
      settling = true;
      // Normal exit: the end-of-script / pre-exec flush already committed
      // VFS mutations. Re-applying the live `realm-fs-write` buffer here
      // would clobber a later exec overwrite of the same path.
      void Promise.resolve().then(() => finish(result, exitForPm));
    };

    const settleKill = (exitCode: number): void => {
      if (settling) return;
      settling = true;
      // One microtask so already-queued persist posts land, then hard-stop
      // so the realm cannot keep enqueueing. Apply the snapshot after
      // terminate — do not wait on VFS while the worker is still alive.
      void Promise.resolve().then(() => {
        const ops = [...capture.pendingByPath.values()];
        capture.pendingByPath.clear();
        hardStop();
        void applyCapturedFsOps(ops, opts.ctx, capture).finally(() => {
          const trailer = realmKilledTrailer(Date.now() - proc.startedAt, exitCode);
          finish({ stdout: capture.stdout, stderr: capture.stderr + trailer, exitCode }, exitCode);
        });
      });
    };

    messageHandler = (event: MessageEvent): void => {
      const data = event.data as { type?: string };
      const kind = ingestLiveRealmMessage(data, capture);
      if (kind === 'done') {
        const done = event.data as RealmDoneMsg;
        settleDone(
          { stdout: done.stdout, stderr: done.stderr, exitCode: done.exitCode },
          done.exitCode
        );
      } else if (kind === 'error') {
        const err = event.data as RealmErrorMsg;
        settleDone(
          { stdout: capture.stdout, stderr: capture.stderr + err.message + '\n', exitCode: 1 },
          1
        );
      }
    };

    errorHandler = (event: Event): void => {
      const message = (event as ErrorEvent).message ?? 'realm error';
      settleDone(
        { stdout: capture.stdout, stderr: capture.stderr + message + '\n', exitCode: 1 },
        1
      );
    };

    // A `messageerror` means the realm posted a message the host could
    // not deserialize (structured-clone failure) — typically a worker
    // that crashed / OOM-died mid-post. No `realm-done` / `realm-error`
    // will follow, so settle non-zero here rather than leave the promise
    // hanging (or, worse, let a later spurious settle land at exit 0).
    messageErrorHandler = (): void => {
      settleDone(
        {
          stdout: capture.stdout,
          stderr: capture.stderr + 'realm-runner: worker message could not be deserialized\n',
          exitCode: 1,
        },
        1
      );
    };

    // Realm code is opaque to us (no cooperative cancel hook), so every
    // terminating signal that reaches THIS realm pid is escalated to a
    // synchronous `realm.terminate()` via `settleKill`. Without this, a
    // terminal Ctrl-C (SIGINT) or `kill <pid>` (SIGTERM) fanned out from
    // the shell parent would only flip `terminatedBy` and the realm would
    // run forever (#1116). Exit codes follow the POSIX 128+signo
    // convention — pinned here rather than relying on PM's
    // signal-derivation so the runner owns the convention. SIGSTOP /
    // SIGCONT are pause/resume, not termination, so they're ignored.
    // Streamed stdout and completed sync writes survive the kill (#3136).
    unsubSignal = opts.pm.onSignal((signaled, sig) => {
      if (signaled.pid !== proc.pid) return;
      const exitCode = SIGNAL_EXIT_CODE[sig as keyof typeof SIGNAL_EXIT_CODE];
      if (exitCode !== undefined) settleKill(exitCode);
    });

    realm.controlPort.addEventListener('message', messageHandler);
    if (realm.addEventListener) {
      realm.addEventListener('error', errorHandler);
      realm.addEventListener('messageerror', messageErrorHandler);
    }

    realm.controlPort.postMessage(buildRealmInitMsg(opts, host, syncSab));
  });
}

/**
 * Allocate the per-realm shared buffer for the Atomics fast path, or
 * `undefined` where `SharedArrayBuffer` is not constructible (a non-isolated
 * document). Exported for tests.
 */
export function allocateSyncSab(windowBytes?: number): SharedArrayBuffer | undefined {
  if (!isSyncSabSupported()) return undefined;
  try {
    return new SharedArrayBuffer(SAB_HEADER_BYTES + (windowBytes ?? SAB_DEFAULT_WINDOW_BYTES));
  } catch {
    // Constructor can still throw (quota, an isolation probe that lied):
    // degrade to the SW / snapshot paths rather than failing the run.
    return undefined;
  }
}
