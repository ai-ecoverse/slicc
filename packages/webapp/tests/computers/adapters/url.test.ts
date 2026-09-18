import type { ComputerDescriptor } from '@slicc/shared-ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  headerGet,
  normalizeComputerBase,
  parseRemoteDescriptor,
  probeUrlComputer,
  UrlComputerBackend,
  type UrlComputerFetch,
  urlComputerId,
} from '../../../src/computers/adapters/url.js';
import { MINIMAL_JPEG } from '../../../src/computers/encode-frame.js';

const LIVE: ComputerDescriptor = {
  id: 'ignored',
  kind: 'v86',
  title: 'computer-demo',
  size: { width: 1, height: 1 },
  state: 'live',
  capabilities: {
    screenshot: true,
    text: true,
    frames: 'poll',
    keyboard: true,
    mouse: 'absolute',
    scroll: true,
    exec: false,
    inputAllowed: true,
  },
  pid: null,
};

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function mockFetch(routes: {
  computer?: { status: number; body: Uint8Array };
  screenshot?: { status: number; body: Uint8Array };
  text?: { status: number; body: Uint8Array };
  input?: { status: number; body: Uint8Array };
}): UrlComputerFetch {
  return async (url, init) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/computer') && !parsed.pathname.endsWith('/computer/input')) {
      const hit = routes.computer ?? { status: 200, body: encodeJson(LIVE) };
      return {
        status: hit.status,
        headers: { 'content-type': 'application/json' },
        body: hit.body,
      };
    }
    if (parsed.pathname.endsWith('/computer/screenshot')) {
      const hit = routes.screenshot ?? { status: 200, body: MINIMAL_JPEG };
      return { status: hit.status, headers: { 'content-type': 'image/jpeg' }, body: hit.body };
    }
    if (parsed.pathname.endsWith('/computer/text')) {
      const hit = routes.text ?? { status: 200, body: new TextEncoder().encode('demo\n') };
      return { status: hit.status, headers: { 'content-type': 'text/plain' }, body: hit.body };
    }
    if (parsed.pathname.endsWith('/computer/input')) {
      const hit = routes.input ?? { status: 200, body: encodeJson({ ok: true }) };
      return {
        status: hit.status,
        headers: { 'content-type': 'application/json' },
        body: hit.body,
      };
    }
    void init;
    return { status: 404, headers: {}, body: new Uint8Array() };
  };
}

describe('url adapter helpers', () => {
  it('normalizes http(s) bases and strips a trailing /computer', () => {
    expect(normalizeComputerBase('http://127.0.0.1:5710')).toBe('http://127.0.0.1:5710');
    expect(normalizeComputerBase('http://127.0.0.1:5710/computer')).toBe('http://127.0.0.1:5710');
    expect(normalizeComputerBase('https://boxes.example/lab/computer/')).toBe(
      'https://boxes.example/lab'
    );
    expect(urlComputerId('http://127.0.0.1:5710/computer')).toBe('url:127.0.0.1:5710');
    expect(urlComputerId('https://boxes.example/lab')).toBe('url:boxes.example/lab');
  });

  it('refuses non-http bases', () => {
    expect(() => normalizeComputerBase('ws://127.0.0.1:5710')).toThrow('only http(s) bases');
    expect(() => normalizeComputerBase('file:///tmp')).toThrow('only http(s) bases');
  });

  it('reads headers from Headers or a record', () => {
    expect(headerGet({ 'Content-Type': 'image/jpeg' }, 'content-type')).toBe('image/jpeg');
    expect(headerGet(new Headers({ 'content-type': 'text/plain' }), 'Content-Type')).toBe(
      'text/plain'
    );
  });

  it('forces kind url and keeps a remote title', () => {
    const desc = parseRemoteDescriptor(LIVE, 'url:127.0.0.1:5710', '127.0.0.1:5710');
    expect(desc.kind).toBe('url');
    expect(desc.id).toBe('url:127.0.0.1:5710');
    expect(desc.title).toBe('computer-demo');
    expect(desc.capabilities.frames).toBe('poll');
  });
});

describe('url probe and backend', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  it('probes GET /computer and drives screenshot/text/input', async () => {
    const fetchImpl = mockFetch({});
    const desc = await probeUrlComputer(fetchImpl, 'http://127.0.0.1:5710/computer');
    expect(desc.id).toBe('url:127.0.0.1:5710');
    const backend = new UrlComputerBackend(fetchImpl, 'http://127.0.0.1:5710', desc);
    expect(backend.subscribe).toBeUndefined();
    const frame = await backend.screenshot({ format: 'jpeg', maxWidth: 768 });
    expect(frame.width).toBe(1);
    expect(frame.height).toBe(1);
    expect(await backend.text()).toBe('demo\n');
    await backend.input([{ type: 'text', text: 'hi' }]);
    await backend.close();
  });

  it('treats text 404 as unsupported and refuses input when the remote says so', async () => {
    const fetchImpl = mockFetch({
      computer: {
        status: 200,
        body: encodeJson({
          ...LIVE,
          capabilities: { ...LIVE.capabilities, text: true, inputAllowed: false },
        }),
      },
      text: { status: 404, body: new Uint8Array() },
    });
    const desc = await probeUrlComputer(fetchImpl, 'http://127.0.0.1:5710');
    const backend = new UrlComputerBackend(fetchImpl, 'http://127.0.0.1:5710', desc);
    expect(await backend.text()).toBeNull();
    await expect(backend.input([{ type: 'wait', ms: 10 }])).rejects.toThrow('input is not allowed');
  });

  it('fails the probe on a non-2xx /computer', async () => {
    const fetchImpl = mockFetch({
      computer: { status: 503, body: encodeJson({ error: 'down' }) },
    });
    await expect(probeUrlComputer(fetchImpl, 'http://127.0.0.1:5710')).rejects.toThrow(
      'GET /computer returned 503'
    );
  });

  it('binds a native WebSocket only when the remote advertises push frames', async () => {
    class FakeSocket {
      binaryType = 'arraybuffer';
      readonly listeners = new Map<string, (event: MessageEvent<ArrayBuffer>) => void>();
      addEventListener(type: string, fn: (event: MessageEvent<ArrayBuffer>) => void): void {
        this.listeners.set(type, fn);
      }
      removeEventListener(type: string): void {
        this.listeners.delete(type);
      }
      close(): void {}
    }
    const sockets: FakeSocket[] = [];
    vi.stubGlobal(
      'WebSocket',
      class {
        constructor(url: string) {
          expect(url).toContain('ws://127.0.0.1:5710/computer/frames');
          const sock = new FakeSocket();
          sockets.push(sock);
          return sock;
        }
      }
    );
    const fetchImpl = mockFetch({
      computer: {
        status: 200,
        body: encodeJson({
          ...LIVE,
          capabilities: { ...LIVE.capabilities, frames: 'push' },
        }),
      },
    });
    const desc = await probeUrlComputer(fetchImpl, 'http://127.0.0.1:5710');
    const backend = new UrlComputerBackend(fetchImpl, 'http://127.0.0.1:5710', desc);
    expect(backend.subscribe).toEqual(expect.any(Function));
    const frames: number[] = [];
    const stop = backend.subscribe?.(4, (frame) => {
      frames.push(frame.seq);
    });
    const copy = MINIMAL_JPEG.slice();
    sockets[0]?.listeners.get('message')?.({
      data: copy.buffer,
    } as MessageEvent<ArrayBuffer>);
    await vi.waitFor(() => expect(frames).toEqual([1]));
    stop?.();
  });
});
