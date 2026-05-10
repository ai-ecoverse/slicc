/**
 * `preemptive-runner.ts` — kernel-side helper that spawns a
 * `kind:'preemptive'` process backed by a per-task DedicatedWorker.
 *
 * The headline guarantee: SIGKILL of a preemptive process really
 * stops the underlying JS — `worker.terminate()` is synchronous and
 * doesn't depend on the running code observing any signal. This is
 * the only way to hard-kill a CPU-tight `while(true){}` loop in
 * the browser without process-level help.
 *
 * Lifecycle:
 *   1. `pm.spawn({kind:'preemptive', argv, owner, …})` — process
 *      record, fresh AbortController, default-resumed Gate.
 *   2. `workerFactory()` — build the worker (production: a real
 *      `Worker` over a Vite URL; tests: a mock).
 *   3. `worker.postMessage({type:'preemptive-init', code, argv,
 *      env})` — kicks off execution in the worker.
 *   4. Subscribe to `worker.onmessage` for `preemptive-done` /
 *      `preemptive-error`; subscribe to `proc.abort.signal` for
 *      caller-driven cancellation.
 *   5. On `preemptive-done`: exit 0 (or the script's
 *      `process.exit(N)` value).
 *      On `preemptive-error`: exit 1 with the error message.
 *      On SIGKILL (`proc.terminatedBy === 'SIGKILL'`):
 *         `worker.terminate()` immediately, exit 137, resolve.
 *      On SIGINT/SIGTERM: NO worker.terminate(). Only SIGKILL is
 *      hard; cooperative signals are recorded but the running code
 *      is opaque to us, so we cannot cooperatively cancel it.
 *      Callers that want to respect cooperative aborts must call
 *      SIGKILL after a grace period (`kill` does this conventionally).
 *
 * Why ONE worker per task? A long-lived pool would need to be
 * recreated after every SIGKILL anyway, and per-task workers give
 * each script a clean realm — no cross-contamination of globals,
 * no surviving timers / listeners. Startup cost is ~10ms in
 * Chromium; negligible against LLM round-trip budgets.
 *
 * Worker safety of THIS file: the runner imports types only from
 * `preemptive-worker.ts`; the worker bundle itself is built by
 * `workerFactory` / Vite. This file lives on the kernel side
 * (worker or page, both work) and threads the lifecycle.
 */

import type { ProcessManager, ProcessOwner } from './process-manager.js';
import type {
  PreemptiveInitMsg,
  PreemptiveDoneMsg,
  PreemptiveErrorMsg,
} from './preemptive-worker.js';

// ---------------------------------------------------------------------------
// Worker abstraction
// ---------------------------------------------------------------------------

/**
 * Structural slice of `Worker` the runner needs. Tests pass a mock
 * with `postMessage`/`terminate`/`addEventListener`/
 * `removeEventListener` — same idea as `WorkerLike` in
 * `kernel/spawn.ts`.
 */
export interface PreemptiveWorkerLike {
  postMessage(message: unknown): void;
  terminate(): void;
  addEventListener(
    type: 'message',
    handler: (event: MessageEvent) => void,
    options?: AddEventListenerOptions
  ): void;
  addEventListener(
    type: 'error',
    handler: (event: ErrorEvent) => void,
    options?: AddEventListenerOptions
  ): void;
  removeEventListener(type: 'message', handler: (event: MessageEvent) => void): void;
  removeEventListener(type: 'error', handler: (event: ErrorEvent) => void): void;
}

export type PreemptiveWorkerFactory = () => PreemptiveWorkerLike;

/**
 * Production worker factory. Vite recognizes the
 * `new Worker(new URL('./preemptive-worker.ts', import.meta.url), …)`
 * pattern and bundles the worker as a separate chunk
 * (`dist/ui/assets/preemptive-worker-*.js`). Tests pass a mock
 * factory instead.
 *
 * The `as unknown as PreemptiveWorkerLike` cast widens the
 * structural type — the real `Worker` has more methods than the
 * subset we use, but the factory's job is just to satisfy the
 * runner's needs.
 */
export function createPreemptiveWorker(): PreemptiveWorkerLike {
  return new Worker(new URL('./preemptive-worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as PreemptiveWorkerLike;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RunPreemptiveOptions {
  pm: ProcessManager;
  workerFactory: PreemptiveWorkerFactory;
  owner: ProcessOwner;
  /** JS source executed inside the worker's `AsyncFunction`. */
  code: string;
  /** Argv exposed to the script as `process.argv`. Defaults to `['preemptive']`. */
  argv?: string[];
  /** Env exposed to the script as `process.env`. Defaults to `{}`. */
  env?: Record<string, string>;
  /** Working dir recorded on the `Process` record. Defaults to `/`. */
  cwd?: string;
  /** Parent pid recorded on the `Process` record. Defaults to 1. */
  ppid?: number;
}

export interface PreemptiveResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function runPreemptiveJs(opts: RunPreemptiveOptions): Promise<PreemptiveResult> {
  const proc = opts.pm.spawn({
    kind: 'preemptive',
    argv: opts.argv ?? ['preemptive'],
    cwd: opts.cwd,
    env: opts.env,
    owner: opts.owner,
    ppid: opts.ppid,
  });

  const worker = opts.workerFactory();
  let settled = false;

  return new Promise<PreemptiveResult>((resolve) => {
    let unsubSignal: (() => void) | null = null;
    let messageHandler: ((event: MessageEvent) => void) | null = null;
    let errorHandler: ((event: ErrorEvent) => void) | null = null;

    const cleanup = (): void => {
      if (messageHandler) worker.removeEventListener('message', messageHandler);
      if (errorHandler) worker.removeEventListener('error', errorHandler);
      unsubSignal?.();
    };

    const settle = (result: PreemptiveResult, exitForPm: number | null): void => {
      if (settled) return;
      settled = true;
      // Order: drop our message/error/signal handlers BEFORE telling
      // the worker to die so a late event arriving during termination
      // doesn't re-enter us. `cleanup()` is idempotent.
      cleanup();
      // terminate() is idempotent on real Workers; the try/catch is
      // pure paranoia for an exotic environment that doesn't
      // implement it (none today).
      try {
        worker.terminate();
      } catch {
        /* unreachable on real Worker */
      }
      opts.pm.exit(proc.pid, exitForPm);
      resolve(result);
    };

    messageHandler = (event: MessageEvent): void => {
      const msg = event.data as PreemptiveDoneMsg | PreemptiveErrorMsg | { type?: string };
      if (msg?.type === 'preemptive-done') {
        const done = msg as PreemptiveDoneMsg;
        settle(
          { stdout: done.stdout, stderr: done.stderr, exitCode: done.exitCode },
          done.exitCode
        );
      } else if (msg?.type === 'preemptive-error') {
        const err = msg as PreemptiveErrorMsg;
        settle({ stdout: '', stderr: err.message + '\n', exitCode: 1 }, 1);
      }
    };

    errorHandler = (event: ErrorEvent): void => {
      const message = event.message ?? 'preemptive worker error';
      settle({ stdout: '', stderr: message + '\n', exitCode: 1 }, 1);
    };

    // ONLY SIGKILL hard-terminates the worker. SIGINT / SIGTERM
    // record `terminatedBy` (and abort the controller) but don't
    // reach into the running JS — its code is a black box from this
    // side. Callers that want hard stop must escalate to SIGKILL
    // after a grace period (`kill` is the conventional escalation).
    //
    // Subscribing to `pm.onSignal` instead of
    // `proc.abort.signal.addEventListener('abort', …)` because:
    //   1. abort fires once on the FIRST aborting signal; SIGKILL
    //      escalating after SIGINT wouldn't re-fire.
    //   2. SIGKILL on a `kind:'preemptive'` proc is uncatchable
    //      (POSIX semantic) — it should always terminate the
    //      worker, regardless of prior signals.
    unsubSignal = opts.pm.onSignal((signaled, sig) => {
      if (signaled.pid !== proc.pid) return;
      if (sig !== 'SIGKILL') return;
      // Pass 137 explicitly. The PM contract today (see
      // `process-manager.ts` `exit(pid, exitCode)`) is that `null`
      // derives the code from `terminatedBy`, but relying on that
      // implicit derivation couples this runner to PM internals —
      // the SIGKILL exit code is a stable POSIX convention, so we
      // own it here.
      settle({ stdout: '', stderr: '', exitCode: 137 }, 137);
    });

    worker.addEventListener('message', messageHandler);
    worker.addEventListener('error', errorHandler);

    const init: PreemptiveInitMsg = {
      type: 'preemptive-init',
      code: opts.code,
      argv: opts.argv ?? ['preemptive'],
      env: opts.env ?? {},
    };
    worker.postMessage(init);
  });
}
