/**
 * An in-memory Web Locks manager with the semantics the six-upgrade stop
 * relies on: `shared` and `exclusive` modes, FIFO queueing (a shared request
 * waits behind a queued exclusive one), `ifAvailable` (null when the request
 * can't be granted at once) and `signal` (aborting a queued request rejects).
 */
import type { SixLockManager } from '../../src/ui/six-upgrade-stop.js';

type Mode = 'shared' | 'exclusive';

interface Pending {
  mode: Mode;
  grant(): void;
}

export class FakeWebLocks implements SixLockManager {
  private readonly held = new Map<string, Mode[]>();
  private readonly queue = new Map<string, Pending[]>();

  heldModes(name: string): Mode[] {
    return [...(this.held.get(name) ?? [])];
  }

  queued(name: string): number {
    return this.queue.get(name)?.length ?? 0;
  }

  private canGrant(name: string, mode: Mode): boolean {
    const held = this.held.get(name) ?? [];
    if (mode === 'exclusive') return held.length === 0;
    return !held.includes('exclusive');
  }

  private pump(name: string): void {
    const queue = this.queue.get(name) ?? [];
    while (queue.length > 0 && this.canGrant(name, queue[0]!.mode)) {
      const next = queue.shift()!;
      next.grant();
      if (next.mode === 'exclusive') break;
    }
  }

  request(
    name: string,
    options: { mode: Mode; ifAvailable?: boolean; signal?: AbortSignal },
    callback: (lock: unknown) => Promise<unknown>
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const run = (): void => {
        const held = this.held.get(name) ?? [];
        held.push(options.mode);
        this.held.set(name, held);
        void Promise.resolve(callback({ name, mode: options.mode }))
          .then(resolve, reject)
          .finally(() => {
            const list = this.held.get(name) ?? [];
            list.splice(list.indexOf(options.mode), 1);
            this.pump(name);
          });
      };
      const queue = this.queue.get(name) ?? [];
      this.queue.set(name, queue);
      if (queue.length === 0 && this.canGrant(name, options.mode)) {
        run();
        return;
      }
      if (options.ifAvailable) {
        void Promise.resolve(callback(null)).then(resolve, reject);
        return;
      }
      const pending: Pending = { mode: options.mode, grant: run };
      queue.push(pending);
      options.signal?.addEventListener('abort', () => {
        const at = queue.indexOf(pending);
        if (at < 0) return;
        queue.splice(at, 1);
        reject(new DOMException('aborted', 'AbortError'));
        this.pump(name);
      });
    });
  }
}

/** A same-origin BroadcastChannel bus: every other channel of the name hears a post. */
export class FakeChannelBus {
  private readonly channels = new Set<FakeChannel>();
  readonly posted: unknown[] = [];

  open(): FakeChannel {
    const channel = new FakeChannel(this);
    this.channels.add(channel);
    return channel;
  }

  deliver(from: FakeChannel, message: unknown): void {
    this.posted.push(message);
    for (const channel of this.channels) {
      if (channel !== from) queueMicrotask(() => channel.emit(message));
    }
  }

  drop(channel: FakeChannel): void {
    this.channels.delete(channel);
  }
}

export class FakeChannel {
  private readonly listeners: ((event: { data: unknown }) => void)[] = [];
  constructor(private readonly bus: FakeChannelBus) {}
  postMessage(message: unknown): void {
    this.bus.deliver(this, message);
  }
  addEventListener(_type: 'message', listener: (event: { data: unknown }) => void): void {
    this.listeners.push(listener);
  }
  emit(data: unknown): void {
    for (const l of this.listeners) l({ data });
  }
  close(): void {
    this.bus.drop(this);
  }
}
