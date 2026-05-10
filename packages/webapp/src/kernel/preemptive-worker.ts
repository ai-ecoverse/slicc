/**
 * `preemptive-worker.ts` — DedicatedWorker entry for hard-killable
 * JS execution.
 *
 * One worker per `runPreemptiveJs` call. The parent kernel posts an
 * init message with `{ code, argv, env }`; the worker runs the code
 * inside an `AsyncFunction` with captured stdout/stderr, then posts
 * a `preemptive-done` message and exits naturally. If the parent
 * decides to terminate (SIGKILL → `worker.terminate()`), this entry
 * point doesn't get to clean up — that's the whole point. The
 * runner translates the missing reply into a 137 exit code.
 *
 * Why a fresh worker per task instead of a long-lived pool?
 *   - Hard kill is the headline feature: `worker.terminate()` is
 *     the ONLY way to stop a CPU-tight `while(true){}` loop
 *     without process-level help. A pool would have to recreate
 *     the worker after every kill anyway.
 *   - Each task gets a clean realm — no cross-contamination of
 *     globals, no surviving timers, no leaked listeners.
 *   - The startup cost is ~10ms in Chromium; negligible compared
 *     to the LLM round-trips that own the user's wall-clock budget.
 *
 * What this worker does NOT have (vs `node -e` / `.jsh`, which run
 * in the kernel realm and have these):
 *   - No `RemoteVfsAdapter`. Future enhancement: route VFS calls
 *     back to the kernel via a MessagePort RPC, similar to
 *     `WorkerCdpProxy`.
 *   - No `RemoteBrowserAPI`. Same reasoning — out of scope.
 *   - No `require()` — node-built-in resolution would need the
 *     kernel-worker's own require shim plumbed in.
 *
 * Runtime safety: this worker has its own globalThis, no DOM, no
 * `localStorage` (Web Workers don't get one — the kernel-worker
 * uses a Map shim, but we don't replicate that here since
 * preemptive scripts are short-lived).
 */

/// <reference lib="webworker" />

declare const self: DedicatedWorkerGlobalScope;

interface PreemptiveInitMsg {
  type: 'preemptive-init';
  code: string;
  argv: string[];
  env: Record<string, string>;
}

interface PreemptiveDoneMsg {
  type: 'preemptive-done';
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface PreemptiveErrorMsg {
  type: 'preemptive-error';
  message: string;
}

self.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { type?: string };
  if (data?.type !== 'preemptive-init') return;
  void runScript(event.data as PreemptiveInitMsg).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    const errMsg: PreemptiveErrorMsg = { type: 'preemptive-error', message };
    self.postMessage(errMsg);
  });
});

async function runScript(init: PreemptiveInitMsg): Promise<void> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const writeStdout = (value: unknown): void => {
    stdoutChunks.push(typeof value === 'string' ? value : String(value));
  };
  const writeStderr = (value: unknown): void => {
    stderrChunks.push(typeof value === 'string' ? value : String(value));
  };

  const consoleShim = {
    log: (...parts: unknown[]) => writeStdout(parts.map(String).join(' ') + '\n'),
    info: (...parts: unknown[]) => writeStdout(parts.map(String).join(' ') + '\n'),
    warn: (...parts: unknown[]) => writeStderr(parts.map(String).join(' ') + '\n'),
    error: (...parts: unknown[]) => writeStderr(parts.map(String).join(' ') + '\n'),
  };

  const processShim = {
    argv: init.argv,
    env: init.env,
    cwd: () => '/',
    stdout: { write: writeStdout },
    stderr: { write: writeStderr },
    exit: (code = 0) => {
      // Sentinel error caught below; carries the exit code.
      throw Object.assign(new Error('process.exit'), { __preemptive_exit_code: code });
    },
  };

  let exitCode = 0;
  try {
    // Same pattern as `executeJsCode`'s CLI mode (jsh-executor.ts):
    // construct an AsyncFunction so `await` works at the top level,
    // and lexically inject the shims rather than mutating globalThis.
    const AsyncFn = Object.getPrototypeOf(async function () {
      /* noop */
    }).constructor as new (
      ...args: string[]
    ) => (console: typeof consoleShim, process: typeof processShim) => Promise<unknown>;
    const fn = new AsyncFn('console', 'process', `"use strict";\n${init.code}`);
    await fn(consoleShim, processShim);
  } catch (err: unknown) {
    if (err && typeof err === 'object' && '__preemptive_exit_code' in err) {
      exitCode = (err as { __preemptive_exit_code: number }).__preemptive_exit_code;
    } else {
      const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
      stderrChunks.push(`${message}\n`);
      exitCode = 1;
    }
  }

  const done: PreemptiveDoneMsg = {
    type: 'preemptive-done',
    stdout: stdoutChunks.join(''),
    stderr: stderrChunks.join(''),
    exitCode,
  };
  self.postMessage(done);
  // The worker stays alive a tiny moment so the postMessage flushes;
  // the kernel-side runner's worker.terminate() in onMessage handler
  // releases it. (Letting the worker self-close via `self.close()`
  // is also valid but races with the postMessage delivery in some
  // browsers.)
}

export type { PreemptiveInitMsg, PreemptiveDoneMsg, PreemptiveErrorMsg };
