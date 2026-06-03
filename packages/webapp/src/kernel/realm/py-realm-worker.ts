/**
 * `py-realm-worker.ts` — DedicatedWorker entry hosting the
 * `kind:'py'` realm. Used in BOTH standalone and extension modes:
 * Pyodide is a WASM interpreter, so it only needs the
 * `wasm-unsafe-eval` privilege the extension already grants worker
 * scripts. (Contrast with JS realms, where the AsyncFunction
 * constructor is blocked by the extension's
 * `script-src 'self' 'wasm-unsafe-eval'` and we have to fall back
 * to a sandbox iframe.)
 *
 * Hosts a single warm `PyRealmSession` (in `py-realm-shared.ts`)
 * that survives between runs: `loadPyodide` is paid once, then each
 * `realm-init` drives one `session.run()`. The pool
 * (`py-realm-pool.ts`) checks this worker out, posts an init, and on
 * `realm-done` returns it idle for the next run — the warm-reuse
 * that skips cold boot. An in-process test factory drives the same
 * `PyRealmSession` path without a real DedicatedWorker.
 *
 * SIGKILL: a runaway `while True: pass` exits when the kernel
 * terminates the worker — Pyodide can't service interrupts inside
 * a tight loop because Python's bytecode interpreter has no yield
 * points there. The pool evicts (terminates) the worker on SIGKILL
 * and lazily replaces it.
 */

/// <reference lib="webworker" />

import { PyRealmSession } from './py-realm-shared.js';
import type { RealmPortLike } from './realm-rpc.js';
import type { RealmErrorMsg, RealmInitMsg } from './realm-types.js';

declare const self: DedicatedWorkerGlobalScope;

const port: RealmPortLike = {
  postMessage: (msg, transfer) =>
    transfer ? self.postMessage(msg, transfer) : self.postMessage(msg),
  addEventListener: (type, handler) => self.addEventListener(type, handler),
  removeEventListener: (type, handler) => self.removeEventListener(type, handler),
};

// The session is created lazily on the first init (it needs the
// init's `pyodideIndexURL`) and reused for every subsequent run.
// `busy` is defensive: the pool guarantees one in-flight run per
// worker, but a stray concurrent init must not corrupt the shared
// interpreter.
let sessionPromise: Promise<PyRealmSession> | null = null;
let busy = false;

self.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { type?: string };
  if (data?.type !== 'realm-init') return;
  const init = event.data as RealmInitMsg;
  if (init.kind !== 'py') return;
  if (busy) return;
  busy = true;
  void (async () => {
    let session: PyRealmSession;
    try {
      if (!sessionPromise) sessionPromise = PyRealmSession.create(init);
      session = await sessionPromise;
    } catch (err) {
      // Reset so a later checkout retries the cold boot (the pool
      // also evicts this worker on realm-error).
      sessionPromise = null;
      const message = err instanceof Error ? err.message : String(err);
      const errMsg: RealmErrorMsg = { type: 'realm-error', message: `loadPyodide: ${message}` };
      self.postMessage(errMsg);
      return;
    }
    try {
      await session.run(init, port);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const errMsg: RealmErrorMsg = { type: 'realm-error', message };
      self.postMessage(errMsg);
    }
  })().finally(() => {
    busy = false;
  });
});
