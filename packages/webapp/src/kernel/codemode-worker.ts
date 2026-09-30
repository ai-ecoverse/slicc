import { _initWorkerSide } from '../shims/worker-threads.js';

globalThis.addEventListener(
  'message',
  async (event: MessageEvent) => {
    _initWorkerSide(event.data);
    try {
      await import('@earendil-works/pi-codemode/worker');
    } catch (err) {
      globalThis.postMessage({
        type: 'crash',
        message: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });
    }
  },
  { once: true }
);
