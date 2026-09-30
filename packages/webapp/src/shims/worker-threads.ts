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
      } catch {}
    }
  }
}

export let workerData: unknown = undefined;
export let parentPort: {
  postMessage(msg: unknown): void;
  on(event: string, fn: ListenerFn): void;
} | null = null;

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
