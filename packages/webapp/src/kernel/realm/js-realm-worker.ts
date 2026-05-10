/**
 * `js-realm-worker.ts` — DedicatedWorker entry hosting the
 * `kind:'js'` realm in standalone mode.
 *
 * Thin wrapper around `runJsRealm` that wires up the worker's
 * `self`-as-port adapter. The actual JS execution lives in
 * `js-realm-shared.ts` so an in-process test factory can drive
 * the same code path without a real DedicatedWorker.
 *
 * Why a worker for standalone JS but an iframe for extension JS?
 * Extension `manifest.json` declares
 * `script-src 'self' 'wasm-unsafe-eval'` for extension pages and
 * inherits that CSP into workers spawned from offscreen, which
 * blocks `AsyncFunction(userCode)`. Sandbox pages run under their
 * own lenient CSP and DO allow `AsyncFunction`. Standalone has no
 * CSP, so a worker is fine.
 */

/// <reference lib="webworker" />

import type { RealmPortLike } from './realm-rpc.js';
import type { RealmErrorMsg, RealmInitMsg } from './realm-types.js';
import { runJsRealm } from './js-realm-shared.js';

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
  if (init.kind !== 'js') return;
  void runJsRealm(init, port).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    const errMsg: RealmErrorMsg = { type: 'realm-error', message };
    self.postMessage(errMsg);
  });
});

export {};
