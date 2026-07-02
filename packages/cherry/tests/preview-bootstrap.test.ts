import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPreviewBridge } from '../src/preview-bootstrap.js';

function fakeWs(over: Partial<Record<string, unknown>> = {}) {
  return {
    send: () => {},
    addEventListener: () => {},
    close: () => {},
    ...over,
  } as never;
}

describe('preview bootstrap', () => {
  afterEach(() => {
    delete (window as any).slicc;
    delete (window as any).__slicc;
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

  it('slicc.emit beacons to /__slicc/emit', () => {
    const beacon = vi.fn();
    (navigator as any).sendBeacon = beacon;
    const bridge = createPreviewBridge({ ws: fakeWs() });
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

  it('IIFE bootstrap opens a WebSocket from the script data attributes and wires open/error/close', async () => {
    const script = document.createElement('script');
    script.setAttribute('data-slicc-token', 'tok-1');
    script.setAttribute('data-slicc-ws', 'wss://x.sliccy.now/__slicc/bridge');
    document.head.appendChild(script);

    const listeners: Record<string, (arg?: unknown) => void> = {};
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
      send() {}
      close() {}
    }
    const origWS = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = FakeWS;

    try {
      vi.resetModules();
      await import('../src/preview-bootstrap.js');
      expect(instances).toHaveLength(1);
      expect(instances[0].url).toBe('wss://x.sliccy.now/__slicc/bridge');

      listeners.open?.();
      expect((window as any).slicc).toBeDefined();

      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      listeners.error?.(new Event('error'));
      listeners.close?.(); // → bridge.stop()
      errSpy.mockRestore();
    } finally {
      (globalThis as any).WebSocket = origWS;
      document.head.removeChild(script);
    }
  });
});
