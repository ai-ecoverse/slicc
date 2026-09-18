import type { ComputerDescriptor, ComputerFrame } from '@slicc/shared-ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  headerGet,
  normalizeComputerBase,
  parseRemoteDescriptor,
  probeUrlComputer,
  URL_REQUEST_TIMEOUT_MS,
  UrlComputerBackend,
  type UrlComputerFetch,
  urlComputerId,
} from '../../../src/computers/adapters/url.js';
import { MINIMAL_JPEG } from '../../../src/computers/encode-frame.js';
import { mapPoint, scaleFromEncoded, toLastShot } from '../../../src/computers/scale.js';

vi.mock('../../../src/computers/encode-frame.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/computers/encode-frame.js')>();
  return {
    ...actual,
    async fitComputerFrame(frame: ComputerFrame, maxWidth: number) {
      if (!maxWidth || frame.width <= maxWidth) return frame;
      const scale = maxWidth / frame.width;
      return {
        seq: frame.seq,
        mime: frame.mime,
        width: Math.max(1, Math.round(frame.width * scale)),
        height: Math.max(1, Math.round(frame.height * scale)),
        bytes: frame.bytes,
      };
    },
  };
});

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

function jpegWithSize(width: number, height: number): Uint8Array {
  const bytes = MINIMAL_JPEG.slice();
  bytes[7] = (height >> 8) & 0xff;
  bytes[8] = height & 0xff;
  bytes[9] = (width >> 8) & 0xff;
  bytes[10] = width & 0xff;
  return bytes;
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
    const headers: Record<string, string> = {};
    return { status: 404, headers, body: new Uint8Array() };
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

  it('keeps native 1920×1080 after a 768-wide encode so lastShot remaps', async () => {
    const jpeg = jpegWithSize(1920, 1080);
    const fetchImpl = mockFetch({ screenshot: { status: 200, body: jpeg } });
    const desc = await probeUrlComputer(fetchImpl, 'http://127.0.0.1:5710');
    const backend = new UrlComputerBackend(fetchImpl, 'http://127.0.0.1:5710', desc);
    const frame = await backend.screenshot({ format: 'jpeg', maxWidth: 768 });
    expect(frame.width).toBe(768);
    expect(frame.height).toBe(432);
    expect(backend.describe().size).toEqual({ width: 1920, height: 1080 });
    const mapping = scaleFromEncoded(backend.describe().size!, {
      width: frame.width,
      height: frame.height,
    });
    expect(mapping.scale).toBeCloseTo(768 / 1920);
    expect(mapPoint(384, 216, toLastShot(mapping, 1), false)).toEqual({ x: 960, y: 540 });
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

  it('aborts stalled probe/screenshot/text/input when the request timeout fires', async () => {
    const timeouts: AbortController[] = [];
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      expect(ms).toBe(URL_REQUEST_TIMEOUT_MS);
      const ac = new AbortController();
      timeouts.push(ac);
      return ac.signal;
    });
    try {
      const stall: UrlComputerFetch = async (_url, init) => {
        const signal = init?.signal;
        if (!signal) throw new Error('missing abort signal');
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            { once: true }
          );
        });
      };
      const probe = probeUrlComputer(stall, 'http://127.0.0.1:5710');
      expect(timeoutSpy).toHaveBeenCalledWith(URL_REQUEST_TIMEOUT_MS);
      timeouts.at(-1)?.abort();
      await expect(probe).rejects.toMatchObject({ name: 'AbortError' });

      const live = mockFetch({});
      const desc = await probeUrlComputer(live, 'http://127.0.0.1:5710');
      const backend = new UrlComputerBackend(stall, 'http://127.0.0.1:5710', desc);
      const shot = backend.screenshot({ format: 'jpeg' });
      const text = backend.text();
      const input = backend.input([{ type: 'text', text: 'x' }]);
      expect(timeouts.length).toBe(5);
      for (const ac of timeouts.slice(-3)) ac.abort();
      await expect(shot).rejects.toMatchObject({ name: 'AbortError' });
      await expect(text).rejects.toMatchObject({ name: 'AbortError' });
      await expect(input).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it('cancels an in-flight screenshot when the polling host aborts', async () => {
    const fetchImpl = mockFetch({});
    const desc = await probeUrlComputer(fetchImpl, 'http://127.0.0.1:5710');
    let seen: AbortSignal | undefined;
    const stall: UrlComputerFetch = (_url, init) => {
      seen = init?.signal;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          { once: true }
        );
      });
    };
    const backend = new UrlComputerBackend(stall, 'http://127.0.0.1:5710', desc);
    const ac = new AbortController();
    const pending = backend.screenshot({ format: 'jpeg', signal: ac.signal });
    expect(seen).toBeDefined();
    expect(seen?.aborted).toBe(false);
    ac.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(seen?.aborted).toBe(true);
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
