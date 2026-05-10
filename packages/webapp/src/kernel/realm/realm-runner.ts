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
 * SIGKILL contract: same as preemptive — only SIGKILL terminates
 * the realm. SIGINT / SIGTERM record `terminatedBy` but the
 * running code is opaque to us, so cooperative cancellation isn't
 * possible. Callers escalate via `kill -KILL <pid>`.
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
import type { RealmDoneMsg, RealmErrorMsg, RealmInitMsg, RealmKind } from './realm-types.js';

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
  /** Optional: kernel-host can subscribe to bootstrap errors. */
  addEventListener?: (
    type: 'error',
    handler: (event: ErrorEvent) => void,
    options?: AddEventListenerOptions
  ) => void;
  removeEventListener?: (type: 'error', handler: (event: ErrorEvent) => void) => void;
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
  /** Optional initial stdin exposed to the user code. */
  stdin?: string;
  /** Pyodide indexURL — only consumed when `kind:'py'`. */
  pyodideIndexURL?: string;
  /** Pyodide VFS sync directories — only consumed when `kind:'py'`. */
  pyodideSyncDirs?: string[];
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

  const host: RealmHostHandle = attachRealmHost(realm.controlPort, opts.ctx);

  return new Promise<RealmResult>((resolve) => {
    let settled = false;
    let unsubSignal: (() => void) | null = null;
    let messageHandler: ((event: MessageEvent) => void) | null = null;
    let errorHandler: ((event: ErrorEvent) => void) | null = null;

    const cleanup = (): void => {
      if (messageHandler) realm.controlPort.removeEventListener('message', messageHandler);
      if (errorHandler && realm.removeEventListener) {
        realm.removeEventListener('error', errorHandler);
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

    errorHandler = (event: ErrorEvent): void => {
      const message = event.message ?? 'realm error';
      settle({ stdout: '', stderr: message + '\n', exitCode: 1 }, 1);
    };

    // SIGKILL escalates unconditionally (POSIX uncatchable). SIGINT /
    // SIGTERM are first-wins by the PM and don't reach into the realm
    // — the running code is opaque, so cooperative cancellation isn't
    // possible from this side.
    unsubSignal = opts.pm.onSignal((signaled, sig) => {
      if (signaled.pid !== proc.pid) return;
      if (sig !== 'SIGKILL') return;
      // 137 = 128 + 9 (SIGKILL). Pinned here rather than relying on
      // PM's signal-derivation so the runner owns the convention.
      settle({ stdout: '', stderr: '', exitCode: 137 }, 137);
    });

    realm.controlPort.addEventListener('message', messageHandler);
    if (realm.addEventListener) realm.addEventListener('error', errorHandler);

    const init: RealmInitMsg = {
      type: 'realm-init',
      kind: opts.kind,
      code: opts.code,
      argv: opts.argv,
      env: opts.env,
      cwd: opts.cwd,
      filename: opts.filename,
      stdin: opts.stdin,
      pyodideIndexURL: opts.pyodideIndexURL,
      pyodideSyncDirs: opts.pyodideSyncDirs,
    };
    realm.controlPort.postMessage(init);
  });
}
