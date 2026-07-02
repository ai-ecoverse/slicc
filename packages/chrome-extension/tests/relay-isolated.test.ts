import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { CHERRY_EVT, CHERRY_RELAY_PORT_NAME } from '../src/cherry-relay-protocol.js';

/** Fake Port that implements the ChromeRuntimePort interface for testing. */
class FakePort {
  name: string;
  postMessage = vi.fn();
  disconnect = vi.fn();
  onMessage = {
    addListener: vi.fn(),
    removeListener: vi.fn(),
    emit: (msg: unknown) => {
      const listeners = this.onMessage.addListener.mock.calls.map((c) => c[0]);
      listeners.forEach((fn) => {
        fn(msg);
      });
    },
  };
  onDisconnect = {
    addListener: vi.fn(),
    emit: () => {
      const listeners = this.onDisconnect.addListener.mock.calls.map((c) => c[0]);
      listeners.forEach((fn) => {
        fn();
      });
    },
  };

  constructor(name: string) {
    this.name = name;
  }
}

/** Fake Window that implements the minimal window interface for testing. */
class FakeWindow {
  private listeners: Map<string, Array<(e: CustomEvent) => void>> = new Map();

  addEventListener(type: string, listener: (e: CustomEvent) => void) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    this.listeners.get(type)!.push(listener);
  }

  removeEventListener(type: string, listener: (e: CustomEvent) => void) {
    const handlers = this.listeners.get(type);
    if (handlers) {
      const idx = handlers.indexOf(listener);
      if (idx !== -1) handlers.splice(idx, 1);
    }
  }

  dispatchEvent(event: CustomEvent) {
    const handlers = this.listeners.get(event.type);
    if (handlers) {
      handlers.forEach((fn) => {
        fn(event);
      });
    }
    return true;
  }
}

describe('relay-isolated', () => {
  let fakePort: FakePort;
  let fakeConnect: Mock<(info: { name: string }) => FakePort>;
  let fakeWindow: FakeWindow;
  let win: Window;
  let fakeScope: { __sliccCherryRelayCleanup?: () => void; __sliccCherryPendingClose?: boolean };
  let timeouts: Array<{ fn: () => void; delay: number }>;
  let fakeSetTimeout: Mock<(fn: () => void, delay: number) => NodeJS.Timeout>;
  // The connect/setTimeout params are typed loosely here so the test doubles
  // (a bare vi.fn returning a FakePort, a capturing fake setTimeout) are
  // assignable — the real initRelay keeps the strict chrome.runtime.connect type.
  let initRelay: (
    connect?: (info: { name: string }) => unknown,
    win?: Window,
    scope?: typeof fakeScope,
    setTimeoutFn?: (fn: () => void, delay: number) => unknown
  ) => void;

  beforeEach(async () => {
    fakePort = new FakePort(CHERRY_RELAY_PORT_NAME);
    fakeConnect = vi.fn((_info: { name: string }) => fakePort);
    fakeWindow = new FakeWindow();
    win = fakeWindow as unknown as Window;
    fakeScope = {};
    timeouts = [];
    fakeSetTimeout = vi.fn((fn: () => void, delay: number) => {
      timeouts.push({ fn, delay });
      return 123 as unknown as NodeJS.Timeout;
    });

    // Dynamic import to avoid module-level side effects
    const mod = await import('../src/relay-isolated.js');
    initRelay = mod.initRelay;
  });

  afterEach(() => {
    vi.clearAllMocks();
    timeouts = [];
  });

  it('connects with the cherry-relay port name on init', () => {
    initRelay(fakeConnect, win, fakeScope, fakeSetTimeout);
    expect(fakeConnect).toHaveBeenCalledWith({ name: CHERRY_RELAY_PORT_NAME });
  });

  it('relays SW join-url to a MAIN CustomEvent', async () => {
    initRelay(fakeConnect, win, fakeScope, fakeSetTimeout);
    const evt = new Promise<CustomEvent>((res) =>
      win.addEventListener(CHERRY_EVT.joinUrl, (e) => res(e as CustomEvent), { once: true })
    );
    fakePort.onMessage.emit({ kind: 'join-url', joinUrl: 'https://w/join/t.s' });
    expect((await evt).detail.joinUrl).toBe('https://w/join/t.s');
  });

  it('forwards MAIN close to the SW port', () => {
    initRelay(fakeConnect, win, fakeScope, fakeSetTimeout);
    win.dispatchEvent(new CustomEvent(CHERRY_EVT.close));
    expect(fakePort.postMessage).toHaveBeenCalledWith({ kind: 'close' });
  });

  it('re-emits the buffered joinUrl when MAIN signals mounted', () => {
    initRelay(fakeConnect, win, fakeScope, fakeSetTimeout);
    fakePort.onMessage.emit({ kind: 'join-url', joinUrl: 'https://w/join/t.s' });
    const spy = vi.fn();
    win.addEventListener(CHERRY_EVT.joinUrl, spy);
    win.dispatchEvent(new CustomEvent(CHERRY_EVT.mounted));
    expect(spy).toHaveBeenCalled();
  });

  it('repeat-injection idempotency: second init disconnects the first Port', () => {
    initRelay(fakeConnect, win, fakeScope, fakeSetTimeout);
    const firstPort = fakePort;
    const secondPort = new FakePort(CHERRY_RELAY_PORT_NAME);
    fakeConnect.mockReturnValueOnce(secondPort);

    initRelay(fakeConnect, win, fakeScope, fakeSetTimeout);

    expect(firstPort.disconnect).toHaveBeenCalled();
    // A join-url after the second init dispatches exactly one event
    const spy = vi.fn();
    win.addEventListener(CHERRY_EVT.joinUrl, spy);
    secondPort.onMessage.emit({ kind: 'join-url', joinUrl: 'https://w/join/t.s' });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('teardown convergence - SW teardown: disconnect called on Port teardown message', () => {
    initRelay(fakeConnect, win, fakeScope, fakeSetTimeout);
    const spy = vi.fn();
    win.addEventListener(CHERRY_EVT.teardown, spy);
    fakePort.onMessage.emit({ kind: 'teardown' });
    expect(spy).toHaveBeenCalled();
    expect(fakePort.disconnect).toHaveBeenCalled();
  });

  it('teardown convergence - MAIN close: posts close then disconnects', () => {
    initRelay(fakeConnect, win, fakeScope, fakeSetTimeout);
    win.dispatchEvent(new CustomEvent(CHERRY_EVT.close));
    expect(fakePort.postMessage).toHaveBeenCalledWith({ kind: 'close' });
    expect(fakePort.disconnect).toHaveBeenCalled();
  });

  it('reconnect on unexpected disconnect', () => {
    initRelay(fakeConnect, win, fakeScope, fakeSetTimeout);
    fakePort.onDisconnect.emit();
    expect(timeouts.length).toBe(1);
    expect(timeouts[0].delay).toBe(500); // RECONNECT_DELAY_MS

    // Advance the timer
    const secondPort = new FakePort(CHERRY_RELAY_PORT_NAME);
    fakeConnect.mockReturnValueOnce(secondPort);
    timeouts[0].fn();
    expect(fakeConnect).toHaveBeenCalledTimes(2);
  });

  it('close during reconnect window is not lost (pendingClose replay)', () => {
    initRelay(fakeConnect, win, fakeScope, fakeSetTimeout);
    // Simulate Port death: postMessage throws
    fakePort.postMessage.mockImplementationOnce(() => {
      throw new Error('Port is dead');
    });

    win.dispatchEvent(new CustomEvent(CHERRY_EVT.close));

    // pendingClose should be set and immediate reconnect scheduled
    expect(fakeScope.__sliccCherryPendingClose).toBe(true);
    expect(timeouts.length).toBe(1);
    expect(timeouts[0].delay).toBe(0); // immediate

    // Advance the timer to trigger reconnect
    const secondPort = new FakePort(CHERRY_RELAY_PORT_NAME);
    fakeConnect.mockReturnValueOnce(secondPort);
    timeouts[0].fn();

    // The new Port should receive the close message
    expect(secondPort.postMessage).toHaveBeenCalledWith({ kind: 'close' });
    expect(secondPort.disconnect).toHaveBeenCalled();
    expect(fakeScope.__sliccCherryPendingClose).toBe(false);
  });

  it('no reconnect on intentional teardown', () => {
    initRelay(fakeConnect, win, fakeScope, fakeSetTimeout);
    // Trigger intentional teardown via cleanup
    fakeScope.__sliccCherryRelayCleanup?.();
    expect(fakePort.disconnect).toHaveBeenCalled();

    // Advance any timers
    timeouts.forEach((t) => {
      t.fn();
    });
    // Should not have called connect again
    expect(fakeConnect).toHaveBeenCalledTimes(1);
  });
});
