/**
 * Browser shim for `node:worker_threads`, used by pi-codemode's host
 * (`runtime/host.js`). Wraps `globalThis.Worker` (a DedicatedWorker) with
 * the subset of Node's `Worker` API that pi-codemode actually uses:
 *
 * - `new Worker(url, { workerData })`: posts `workerData` as the first message
 * - `on('message' | 'error' | 'exit', fn)`: event listeners
 * - `postMessage(msg)`: post to the worker
 * - `terminate()`: kill the worker
 *
 * The companion worker entry (`kernel/codemode-worker.ts`) waits for the
 * first message to populate `workerData` and `parentPort`, then imports
 * `@earendil-works/pi-codemode/worker`.
 */

type ListenerFn = (...args: unknown[]) => void;

export class Worker {
  private readonly worker: globalThis.Worker;
  private readonly listeners = new Map<string, Set<ListenerFn>>();
  private exited = false;

  constructor(url: string | URL, options?: { workerData?: unknown }) {
    this.worker = new globalThis.Worker(url, { type: 'module' });

    this.worker.onmessage = (event: MessageEvent) => {
      this.emit('message', event.data);
    };

    this.worker.onerror = (event: ErrorEvent) => {
      const error = new Error(event.message ?? 'Worker error');
      this.emit('error', error);
    };

    if (options?.workerData !== undefined) {
      this.worker.postMessage(options.workerData);
    }
  }

  on(event: string, fn: ListenerFn): this {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn);
    return this;
  }

  postMessage(message: unknown): void {
    this.worker.postMessage(message);
  }

  async terminate(): Promise<number> {
    if (!this.exited) {
      this.exited = true;
      this.worker.terminate();
      this.emit('exit', 0);
    }
    return 0;
  }

  private emit(event: string, ...args: unknown[]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(...args);
      } catch {
        // Listener errors must not crash the host.
      }
    }
  }
}

export let workerData: unknown = undefined;
export let parentPort: {
  postMessage(msg: unknown): void;
  on(event: string, fn: ListenerFn): void;
} | null = null;

/**
 * Called by `codemode-worker.ts` once the first message arrives. Sets the
 * module-level `workerData` and `parentPort` bindings that
 * `@earendil-works/pi-codemode/worker` reads at top level.
 */
export function _initWorkerSide(data: unknown): void {
  workerData = data;
  const listeners = new Map<string, Set<ListenerFn>>();
  parentPort = {
    postMessage(msg: unknown) {
      globalThis.postMessage(msg);
    },
    on(event: string, fn: ListenerFn) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(fn);
    },
  };
  globalThis.addEventListener('message', (event: MessageEvent) => {
    const set = listeners.get('message');
    if (!set) return;
    for (const fn of set) fn(event.data);
  });
}
