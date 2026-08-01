import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPreviewBridge } from '../src/preview-bootstrap.js';

function fakeWs(over: Partial<Record<string, unknown>> = {}) {
  return {
    send: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    close: () => {},
    ...over,
  } as never;
}

describe('preview bootstrap', () => {
  afterEach(() => {
    delete (window as any).slicc;
    delete (window as any).__slicc;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('answers Runtime.evaluate cdp.req with a cdp.res', async () => {
    const sent: any[] = [];
    const bridge = createPreviewBridge({
      ws: fakeWs({ send: (s: string) => sent.push(JSON.parse(s)) }),
      capabilities: { navigate: true, screenshot: 'none', openUrl: true },
    });
    await bridge.handleFrame({
      t: 'cdp.req',
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression: '1+1' },
    });
    expect(sent).toContainEqual(expect.objectContaining({ t: 'cdp.res', id: 1 }));
  });

  it('handleFrame returns a cdp.res error for unsupported methods', async () => {
    const sent: any[] = [];
    const bridge = createPreviewBridge({
      ws: fakeWs({ send: (s: string) => sent.push(JSON.parse(s)) }),
      capabilities: { navigate: false, screenshot: 'none', openUrl: false },
    });
    await bridge.handleFrame({ t: 'cdp.req', id: 2, method: 'Totally.Unsupported', params: {} });
    const res = sent.find((m) => m.id === 2);
    expect(res.error).toBeDefined();
    expect(res.error.code).toBe(-32601);
  });

  it('does not send when the ws is not open (readyState CLOSED)', async () => {
    const sent: string[] = [];
    const bridge = createPreviewBridge({
      // WebSocket.CLOSED === 3
      ws: fakeWs({ readyState: 3, send: (s: string) => sent.push(s) }),
    });
    await bridge.handleFrame({
      t: 'cdp.req',
      id: 9,
      method: 'Runtime.evaluate',
      params: { expression: '1' },
    });
    expect(sent).toHaveLength(0);
  });

  it('slicc.emit sends over the WS when open (attributable), not a beacon', () => {
    const sent: string[] = [];
    const beacon = vi.fn();
    (navigator as any).sendBeacon = beacon;
    const bridge = createPreviewBridge({
      ws: fakeWs({ readyState: 1, send: (s: string) => sent.push(s) }),
    });
    bridge.installWindowApi();
    (window as any).slicc.emit('clicked', { id: 3 });
    const frame = sent.map((s) => JSON.parse(s)).find((m) => m.t === 'emit');
    expect(frame).toMatchObject({ t: 'emit', name: 'clicked', detail: { id: 3 } });
    expect(beacon).not.toHaveBeenCalled();
  });

  it('slicc.emit falls back to a beacon when the WS is not open', () => {
    const beacon = vi.fn();
    (navigator as any).sendBeacon = beacon;
    // readyState 3 = CLOSED (e.g. during page unload)
    const bridge = createPreviewBridge({ ws: fakeWs({ readyState: 3 }) });
    bridge.installWindowApi();
    (window as any).slicc.emit('clicked', { id: 3 });
    expect(beacon).toHaveBeenCalledWith('/__slicc/emit', expect.stringContaining('clicked'));
  });

  it('slicc.on subscribes to window events and forwards detail; __slicc mirrors slicc', () => {
    const bridge = createPreviewBridge({ ws: fakeWs() });
    bridge.installWindowApi();
    const received: unknown[] = [];
    (window as any).slicc.on('my-evt', (d: unknown) => received.push(d));
    window.dispatchEvent(new CustomEvent('my-evt', { detail: { x: 42 } }));
    expect(received).toEqual([{ x: 42 }]);
    expect((window as any).__slicc).toBe((window as any).slicc);
  });

  it('start() wires the ws message listener and dispatches cdp.req frames', async () => {
    const sent: any[] = [];
    let messageHandler: ((e: { data: string }) => Promise<void>) | null = null;
    const bridge = createPreviewBridge({
      ws: fakeWs({
        readyState: 1, // OPEN
        send: (s: string) => sent.push(JSON.parse(s)),
        addEventListener: (type: string, cb: (e: { data: string }) => Promise<void>) => {
          if (type === 'message') messageHandler = cb;
        },
      }),
      capabilities: { navigate: false, screenshot: 'none', openUrl: false },
    });
    bridge.start();
    expect(messageHandler).toBeTypeOf('function');
    await messageHandler!({
      data: JSON.stringify({
        t: 'cdp.req',
        id: 5,
        method: 'Runtime.evaluate',
        params: { expression: '2' },
      }),
    });
    expect(sent).toContainEqual(expect.objectContaining({ t: 'cdp.res', id: 5 }));
    bridge.stop();
  });

  it('start() ignores non-cdp.req frames and swallows invalid JSON', async () => {
    const sent: any[] = [];
    let messageHandler: ((e: { data: string }) => Promise<void>) | null = null;
    const bridge = createPreviewBridge({
      ws: fakeWs({
        readyState: 1,
        send: (s: string) => sent.push(JSON.parse(s)),
        addEventListener: (type: string, cb: (e: { data: string }) => Promise<void>) => {
          if (type === 'message') messageHandler = cb;
        },
      }),
    });
    bridge.start();
    await messageHandler!({ data: JSON.stringify({ t: 'other' }) });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await messageHandler!({ data: 'not-json{' });
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
    expect(sent).toHaveLength(0);
    bridge.stop();
  });

  it('start() skips the DO "pong" keepalive auto-response without logging an error', async () => {
    let messageHandler: ((e: { data: string }) => Promise<void>) | null = null;
    const bridge = createPreviewBridge({
      ws: fakeWs({
        readyState: 1,
        addEventListener: (type: string, cb: (e: { data: string }) => Promise<void>) => {
          if (type === 'message') messageHandler = cb;
        },
      }),
    });
    bridge.start();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await messageHandler!({ data: 'pong' });
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
    bridge.stop();
  });

  it('start() sends a literal "ping" every 30s (matches the DO auto-response); stop() clears it and closes an open ws', () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const close = vi.fn();
    const bridge = createPreviewBridge({
      ws: fakeWs({ readyState: 1, send: (s: string) => sent.push(s), close }),
    });
    bridge.start();
    vi.advanceTimersByTime(30_000);
    // Literal 'ping' string, NOT JSON {t:'ping'} — so the hibernation
    // auto-response answers it without waking the Durable Object.
    expect(sent).toContain('ping');
    bridge.stop();
    expect(close).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(90_000);
    expect(sent.filter((m) => m === 'ping')).toHaveLength(1); // no pings after stop
  });

  it('pings at visibility transitions and reconnects immediately when visible', () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const replacement = fakeWs({ readyState: 1 });
    const createWebSocket = vi.fn(() => replacement);
    const initial = fakeWs({ readyState: 1, send: (data: string) => sent.push(data) }) as {
      readyState: number;
      close(): void;
    };
    initial.close = () => {
      initial.readyState = 3;
    };
    const bridge = createPreviewBridge({
      ws: initial as never,
      createWebSocket,
    });
    bridge.start();

    document.dispatchEvent(new Event('visibilitychange'));
    expect(sent).toContain('ping');

    window.dispatchEvent(new PageTransitionEvent('pagehide'));
    vi.advanceTimersByTime(60_000);
    expect(createWebSocket).not.toHaveBeenCalled();

    visibility.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(createWebSocket).toHaveBeenCalledTimes(1);
    document.dispatchEvent(new Event('visibilitychange'));
    bridge.stop();
  });

  it('resumes the bridge when a pagehide is restored from BFCache with pageshow', () => {
    const sent: string[] = [];
    const initial = fakeWs({ readyState: 1 }) as { readyState: number; close(): void };
    initial.close = () => {
      initial.readyState = 3;
    };
    const createWebSocket = vi.fn(() =>
      fakeWs({ readyState: 1, send: (data: string) => sent.push(data) })
    );
    const bridge = createPreviewBridge({ ws: initial as never, createWebSocket });
    bridge.start();

    window.dispatchEvent(new PageTransitionEvent('pagehide'));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));

    expect(createWebSocket).toHaveBeenCalledTimes(1);
    expect(sent).toEqual(['ping']);
    bridge.stop();
  });

  it('creates one socket and sends one ping when pageshow and visibilitychange both restore', () => {
    const sent: string[] = [];
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const initial = fakeWs({ readyState: 1 }) as { readyState: number; close(): void };
    initial.close = () => {
      initial.readyState = 3;
    };
    const createWebSocket = vi.fn(() =>
      fakeWs({ readyState: 1, send: (data: string) => sent.push(data) })
    );
    const bridge = createPreviewBridge({ ws: initial as never, createWebSocket });
    bridge.start();

    window.dispatchEvent(new PageTransitionEvent('pagehide'));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    document.dispatchEvent(new Event('visibilitychange'));

    expect(visibility).toHaveReturnedWith('visible');
    expect(createWebSocket).toHaveBeenCalledTimes(1);
    expect(sent.filter((data) => data === 'ping')).toHaveLength(1);
    bridge.stop();
  });

  it('does not resume a stopped bridge on pageshow', () => {
    const sent: string[] = [];
    const addEventListener = vi.spyOn(window, 'addEventListener');
    const createWebSocket = vi.fn(() =>
      fakeWs({ readyState: 1, send: (data: string) => sent.push(data) })
    );
    const bridge = createPreviewBridge({ ws: fakeWs({ readyState: 1 }), createWebSocket });
    bridge.start();
    const pageshowListener = addEventListener.mock.calls.find(
      ([type]) => type === 'pageshow'
    )?.[1] as EventListener | undefined;
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
    bridge.stop();

    pageshowListener?.(new PageTransitionEvent('pageshow', { persisted: true }));

    expect(createWebSocket).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it('removes the pageshow listener on teardown', () => {
    const addEventListener = vi.spyOn(window, 'addEventListener');
    const removeEventListener = vi.spyOn(window, 'removeEventListener');
    const bridge = createPreviewBridge({ ws: fakeWs({ readyState: 1 }) });
    bridge.start();
    const pageshowListener = addEventListener.mock.calls.find(([type]) => type === 'pageshow')?.[1];
    bridge.stop();

    expect(removeEventListener).toHaveBeenCalledWith('pageshow', pageshowListener);
  });

  it('reconnects unexpected closes with bounded exponential backoff', () => {
    vi.useFakeTimers();
    let closeHandler: ((event: Event) => void) | undefined;
    const reconnectError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const createWebSocket = vi
      .fn(() => fakeWs({ readyState: 3 }))
      .mockImplementationOnce(() => {
        throw new Error('constructor failed');
      });
    const bridge = createPreviewBridge({
      ws: fakeWs({
        readyState: 1,
        addEventListener: (type: string, callback: (event: Event) => void) => {
          if (type === 'close') closeHandler = callback;
        },
      }),
      createWebSocket,
    });
    bridge.start();
    closeHandler?.(new Event('close'));

    vi.advanceTimersByTime(999);
    expect(createWebSocket).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(createWebSocket).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_999);
    expect(createWebSocket).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(createWebSocket).toHaveBeenCalledTimes(2);
    vi.runAllTimers();
    expect(createWebSocket).toHaveBeenCalledTimes(5);
    expect(reconnectError).toHaveBeenCalledWith(
      '[preview-bridge] WebSocket reconnect failed:',
      expect.any(Error)
    );
    bridge.stop();
  });

  it('does not reconnect after stop()', () => {
    vi.useFakeTimers();
    let closeHandler: ((event: Event) => void) | undefined;
    const createWebSocket = vi.fn(() => fakeWs({ readyState: 1 }));
    const bridge = createPreviewBridge({
      ws: fakeWs({
        readyState: 1,
        addEventListener: (type: string, callback: (event: Event) => void) => {
          if (type === 'close') closeHandler = callback;
        },
      }),
      createWebSocket,
    });
    bridge.start();
    closeHandler?.(new Event('close'));
    bridge.stop();
    vi.runAllTimers();
    expect(createWebSocket).not.toHaveBeenCalled();
  });

  it('IIFE bootstrap opens a WebSocket from the script data attributes and wires open/error/close', async () => {
    vi.useFakeTimers();
    const script = document.createElement('script');
    script.setAttribute('data-slicc-token', 'tok-1');
    script.setAttribute('data-slicc-ws', 'wss://x.sliccy.now/__slicc/bridge');
    document.head.appendChild(script);

    const listeners: Record<string, (arg?: unknown) => void> = {};
    const sent: any[] = [];
    const instances: Array<{ url: string }> = [];
    class FakeWS {
      static OPEN = 1;
      readyState = 1;
      url: string;
      constructor(url: string) {
        this.url = url;
        instances.push(this);
      }
      addEventListener(type: string, cb: (arg?: unknown) => void) {
        listeners[type] = cb;
      }
      removeEventListener(type: string) {
        delete listeners[type];
      }
      send(s: string) {
        sent.push(JSON.parse(s));
      }
      close() {}
    }
    const origWS = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = FakeWS;

    try {
      vi.resetModules();
      await import('../src/preview-bootstrap.js');
      expect(instances).toHaveLength(1);
      expect(instances[0]?.url).toBe('wss://x.sliccy.now/__slicc/bridge');

      // window.slicc is installed SYNCHRONOUSLY at bootstrap — before the socket
      // opens — so inline page scripts never see it undefined.
      expect((window as any).slicc).toBeDefined();

      listeners.open?.();

      // The IIFE wires full-drive capabilities: a Target.createTarget (openUrl)
      // must NOT come back as an unsupported-method error (-32601). A regression
      // to the all-off default would reject it.
      const messageHandler = listeners.message as
        | ((e: { data: string }) => Promise<void>)
        | undefined;
      await messageHandler?.({
        data: JSON.stringify({ t: 'cdp.req', id: 7, method: 'Target.createTarget', params: {} }),
      });
      const res = sent.find((m) => m.t === 'cdp.res' && m.id === 7);
      expect(res).toBeDefined();
      expect(res.error).toBeUndefined();

      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      listeners.error?.(new Event('error'));
      listeners.close?.();
      vi.advanceTimersByTime(1_000);
      expect(instances).toHaveLength(2);
      window.dispatchEvent(new PageTransitionEvent('pagehide'));
      errSpy.mockRestore();
    } finally {
      (globalThis as any).WebSocket = origWS;
      document.head.removeChild(script);
    }
  });
});
