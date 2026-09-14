/// <reference lib="webworker" />

import { runJsRealm } from './js-realm-shared.js';
import type { RealmPortLike } from './realm-rpc.js';
import type { RealmErrorMsg, RealmInitMsg } from './realm-types.js';

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
