import type {
  RealmEventMsg,
  RealmRpcChannel,
  RealmRpcRequest,
  RealmRpcResponse,
} from './realm-types.js';

export interface RealmPortLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', handler: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', handler: (event: MessageEvent) => void): void;
  start?(): void;
}

export class RealmRpcClient {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  private readonly eventSubscribers = new Map<string, Set<(payload: unknown) => void>>();
  private readonly progressWaiters = new Set<() => void>();
  private readonly handler: (event: MessageEvent) => void;
  private disposed = false;

  constructor(private readonly port: RealmPortLike) {
    this.handler = (event: MessageEvent): void => {
      const data = event.data as { type?: string };
      if (data?.type === 'realm-rpc-res') {
        const res = event.data as RealmRpcResponse;
        const slot = this.pending.get(res.id);
        if (!slot) return;
        this.pending.delete(res.id);
        if (typeof res.error === 'string') {
          slot.reject(new Error(res.error));
        } else {
          slot.resolve(res.result);
        }
        this.notifyProgress();
        return;
      }
      if (data?.type === 'realm-event') {
        const evt = event.data as RealmEventMsg;
        const subs = this.eventSubscribers.get(evt.channel);
        if (!subs) return;
        for (const sub of [...subs]) {
          try {
            sub(evt.payload);
          } catch {}
        }
      }
    };
    port.addEventListener('message', this.handler);
    port.start?.();
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  waitForProgress(): Promise<void> {
    if (this.pending.size === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.progressWaiters.add(resolve);
    });
  }

  private notifyProgress(): void {
    if (this.progressWaiters.size === 0) return;
    const waiters = [...this.progressWaiters];
    this.progressWaiters.clear();
    for (const waiter of waiters) waiter();
  }

  call<T = unknown>(channel: RealmRpcChannel, op: string, args: unknown[] = []): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new Error('realm-rpc: client disposed'));
    }
    const id = this.nextId++;
    const request: RealmRpcRequest = { type: 'realm-rpc-req', id, channel, op, args };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.port.postMessage(request);
    });
  }

  onEvent(channel: string, handler: (payload: unknown) => void): () => void {
    if (this.disposed) return () => {};
    let subs = this.eventSubscribers.get(channel);
    if (!subs) {
      subs = new Set();
      this.eventSubscribers.set(channel, subs);
    }
    subs.add(handler);
    return () => {
      const set = this.eventSubscribers.get(channel);
      if (!set) return;
      set.delete(handler);
      if (set.size === 0) this.eventSubscribers.delete(channel);
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.port.removeEventListener('message', this.handler);
    const err = new Error('realm-rpc: client disposed');
    for (const slot of this.pending.values()) slot.reject(err);
    this.pending.clear();
    this.eventSubscribers.clear();
    this.notifyProgress();
  }
}
