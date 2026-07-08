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
 *      137 + `realm.terminate()`).
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
  RealmInitMsg,
  RealmKind,
  RealmMountPoint,
} from './realm-types.js';

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
}

export interface RealmResult {
  stdout: string;
  stderr: string;
  exitCode: number;
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
  const host: RealmHostHandle = attachRealmHost(realm.controlPort, opts.ctx, {
    ...(opts.owner.scoopJid !== undefined ? { scoopJid: opts.owner.scoopJid } : {}),
    pm: opts.pm,
    owner: opts.owner,
    ppid: proc.pid,
  });

  return new Promise<RealmResult>((resolve) => {
    let settled = false;
    let unsubSignal: (() => void) | null = null;
    let messageHandler: ((event: MessageEvent) => void) | null = null;
    let errorHandler: ((event: Event) => void) | null = null;
    let messageErrorHandler: ((event: Event) => void) | null = null;

    const cleanup = (): void => {
      if (messageHandler) realm.controlPort.removeEventListener('message', messageHandler);
      if (realm.removeEventListener) {
        if (errorHandler) realm.removeEventListener('error', errorHandler);
        if (messageErrorHandler) realm.removeEventListener('messageerror', messageErrorHandler);
      }
      unsubSignal?.();
      host.dispose();
    };

    const settle = (result: RealmResult, exitForPm: number | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        realm.terminate();
      } catch {
        /* idempotent on real workers / iframes */
      }
      opts.pm.exit(proc.pid, exitForPm);
      resolve(result);
    };

    messageHandler = (event: MessageEvent): void => {
      const data = event.data as { type?: string };
      if (data?.type === 'realm-done') {
        const done = event.data as RealmDoneMsg;
        settle(
          { stdout: done.stdout, stderr: done.stderr, exitCode: done.exitCode },
          done.exitCode
        );
      } else if (data?.type === 'realm-error') {
        const err = event.data as RealmErrorMsg;
        settle({ stdout: '', stderr: err.message + '\n', exitCode: 1 }, 1);
      }
    };

    errorHandler = (event: Event): void => {
      const message = (event as ErrorEvent).message ?? 'realm error';
      settle({ stdout: '', stderr: message + '\n', exitCode: 1 }, 1);
    };

    // A `messageerror` means the realm posted a message the host could
    // not deserialize (structured-clone failure) — typically a worker
    // that crashed / OOM-died mid-post. No `realm-done` / `realm-error`
    // will follow, so settle non-zero here rather than leave the promise
    // hanging (or, worse, let a later spurious settle land at exit 0).
    messageErrorHandler = (): void => {
      settle(
        {
          stdout: '',
          stderr: 'realm-runner: worker message could not be deserialized\n',
          exitCode: 1,
        },
        1
      );
    };

    // Realm code is opaque to us (no cooperative cancel hook), so every
    // terminating signal that reaches THIS realm pid is escalated to a
    // synchronous `realm.terminate()` via `settle`. Without this, a
    // terminal Ctrl-C (SIGINT) or `kill <pid>` (SIGTERM) fanned out from
    // the shell parent would only flip `terminatedBy` and the realm would
    // run forever (#1116). Exit codes follow the POSIX 128+signo
    // convention — pinned here rather than relying on PM's
    // signal-derivation so the runner owns the convention. SIGSTOP /
    // SIGCONT are pause/resume, not termination, so they're ignored.
    unsubSignal = opts.pm.onSignal((signaled, sig) => {
      if (signaled.pid !== proc.pid) return;
      if (sig === 'SIGKILL') {
        settle({ stdout: '', stderr: '', exitCode: 137 }, 137);
      } else if (sig === 'SIGINT') {
        settle({ stdout: '', stderr: '', exitCode: 130 }, 130);
      } else if (sig === 'SIGTERM') {
        settle({ stdout: '', stderr: '', exitCode: 143 }, 143);
      }
    });

    realm.controlPort.addEventListener('message', messageHandler);
    if (realm.addEventListener) {
      realm.addEventListener('error', errorHandler);
      realm.addEventListener('messageerror', messageErrorHandler);
    }

    const init: RealmInitMsg = {
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
    };
    realm.controlPort.postMessage(init);
  });
}
