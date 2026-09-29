/// <reference lib="webworker" />

import { processEntry } from './process-entry.js';

declare const self: DedicatedWorkerGlobalScope;

const onMessage = processEntry({ postMessage: (msg: unknown) => self.postMessage(msg) });
self.addEventListener('message', (event: MessageEvent) => onMessage(event.data));
