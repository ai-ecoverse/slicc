/**
 * In-memory BroadcastChannel polyfill for tests. Neither the node vitest env
 * nor jsdom provides a working cross-instance BroadcastChannel; this mirrors
 * the real async-same-thread delivery via queueMicrotask. Based on the pattern
 * in tests/kernel/panel-rpc.test.ts. Install onto globalThis BEFORE code
 * constructs `new BroadcastChannel(...)`.
 */
export class FakeBroadcastChannel {
  private static buses = new Map<string, Set<FakeBroadcastChannel>>();
  private listeners = new Set<(ev: MessageEvent) => void>();
  private closed = false;

  constructor(public readonly name: string) {
    let bus = FakeBroadcastChannel.buses.get(name);
    if (!bus) {
      bus = new Set();
      FakeBroadcastChannel.buses.set(name, bus);
    }
    bus.add(this);
  }
  postMessage(data: unknown): void {
    if (this.closed) return;
    const bus = FakeBroadcastChannel.buses.get(this.name);
    if (!bus) return;
    for (const peer of bus) {
      if (peer === this || peer.closed) continue;
      queueMicrotask(() => {
        for (const l of peer.listeners) l(new MessageEvent('message', { data }));
      });
    }
  }
  addEventListener(_t: 'message', l: (ev: MessageEvent) => void): void {
    this.listeners.add(l);
  }
  removeEventListener(_t: 'message', l: (ev: MessageEvent) => void): void {
    this.listeners.delete(l);
  }
  close(): void {
    this.closed = true;
    FakeBroadcastChannel.buses.get(this.name)?.delete(this);
  }
}

let original: unknown;
export function installFakeBroadcastChannel(): void {
  original = (globalThis as Record<string, unknown>).BroadcastChannel;
  (globalThis as Record<string, unknown>).BroadcastChannel = FakeBroadcastChannel;
}
export function resetFakeBroadcastChannel(): void {
  (FakeBroadcastChannel as unknown as { buses: Map<string, unknown> }).buses = new Map();
  (globalThis as Record<string, unknown>).BroadcastChannel = original;
}
