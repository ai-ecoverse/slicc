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
 * Thin wrapper around `runPyRealm` (in `py-realm-shared.ts`) so an
 * in-process test factory can drive the same code path without a
 * real DedicatedWorker.
 *
 * SIGKILL: a runaway `while True: pass` exits when the kernel
 * terminates the worker — Pyodide can't service interrupts inside
 * a tight loop because Python's bytecode interpreter has no yield
 * points there.
 */

/// <reference lib="webworker" />

import type { RealmPortLike } from './realm-rpc.js';
import type { RealmErrorMsg, RealmInitMsg } from './realm-types.js';
import { runPyRealm } from './py-realm-shared.js';

declare const self: DedicatedWorkerGlobalScope;

const port: RealmPortLike = {
  postMessage: (msg, transfer) =>
    transfer ? self.postMessage(msg, transfer) : self.postMessage(msg),
  addEventListener: (type, handler) => self.addEventListener(type, handler),
  removeEventListener: (type, handler) => self.removeEventListener(type, handler),
};

self.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { type?: string };
  if (data?.type !== 'realm-init') return;
  const init = event.data as RealmInitMsg;
  if (init.kind !== 'py') return;
  void runPyRealm(init, port).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    const errMsg: RealmErrorMsg = { type: 'realm-error', message };
    self.postMessage(errMsg);
  });
});

export {};
