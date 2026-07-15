import { afterEach, expect, test, vi } from 'vitest';
import { createSyncFsXhrBridge } from '../../../src/kernel/realm/sync-fs-xhr-bridge.js';

interface FakeReply {
  status: number;
  body?: Uint8Array;
  errno?: string;
  throwOnSend?: boolean;
  /** Omit the `x-slicc-fs` marker to simulate an SPA fallback / stale SW. */
  noMarker?: boolean;
}

interface SentRecord {
  method: string;
  url: string;
  token: string | null;
  body: unknown;
}

let reply: FakeReply = { status: 200 };
let lastSent: SentRecord | null = null;

/** Minimal synchronous-XHR stand-in (node has no XMLHttpRequest). */
class FakeXHR {
  method = '';
  url = '';
  responseType = '';
  timeout = 0;
  status = 0;
  response: ArrayBuffer = new ArrayBuffer(0);
  private headers: Record<string, string> = {};

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(k: string, v: string): void {
    this.headers[k.toLowerCase()] = v;
  }
  send(body?: unknown): void {
    lastSent = {
      method: this.method,
      url: this.url,
      token: this.headers['x-slicc-fs-token'] ?? null,
      body,
    };
    if (reply.throwOnSend) throw new Error('network error');
    this.status = reply.status;
    if (reply.body) {
      const b = reply.body;
      this.response = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    }
  }
  getResponseHeader(name: string): string | null {
    const n = name.toLowerCase();
    if (n === 'x-slicc-fs-errno') return reply.errno ?? null;
    if (n === 'x-slicc-fs') return reply.noMarker ? null : '1';
    return null;
  }
}

function installFakeXhr(): void {
  vi.stubGlobal('XMLHttpRequest', FakeXHR as unknown as typeof XMLHttpRequest);
}

afterEach(() => {
  vi.unstubAllGlobals();
  reply = { status: 200 };
  lastSent = null;
});

test('readFile returns bytes on 200 and sends token + GET to the route', () => {
  installFakeXhr();
  reply = { status: 200, body: new TextEncoder().encode('hi') };
  const bridge = createSyncFsXhrBridge('tok-1');
  const bytes = bridge.readFile('/workspace/a.txt');
  expect(new TextDecoder().decode(bytes)).toBe('hi');
  expect(lastSent?.method).toBe('GET');
  expect(lastSent?.url).toBe('/__slicc/fs-sync/workspace/a.txt');
  expect(lastSent?.token).toBe('tok-1');
});

test('readFile throws Error with .code=ENOENT on 404 + errno header', () => {
  installFakeXhr();
  reply = { status: 404, errno: 'ENOENT' };
  const bridge = createSyncFsXhrBridge('tok');
  expect(() => bridge.readFile('/missing')).toThrow(expect.objectContaining({ code: 'ENOENT' }));
});

test('writeFile POSTs the body and succeeds on 200', () => {
  installFakeXhr();
  reply = { status: 200 };
  const bridge = createSyncFsXhrBridge('tok');
  bridge.writeFile('/workspace/out.txt', new TextEncoder().encode('X'));
  expect(lastSent?.method).toBe('POST');
  expect(lastSent?.url).toBe('/__slicc/fs-sync/workspace/out.txt');
  expect(new TextDecoder().decode(lastSent?.body as Uint8Array)).toBe('X');
});

test('writeFile throws .code=EACCES on 403 (out-of-sandbox / bad token)', () => {
  installFakeXhr();
  reply = { status: 403, errno: 'EACCES' };
  const bridge = createSyncFsXhrBridge('tok');
  expect(() => bridge.writeFile('/secret', new Uint8Array([1]))).toThrow(
    expect.objectContaining({ code: 'EACCES' })
  );
});

test('a transport failure (timeout / no SW) throws .code=EIO (fail closed)', () => {
  installFakeXhr();
  reply = { status: 0, throwOnSend: true };
  const bridge = createSyncFsXhrBridge('tok', { timeoutMs: 5 });
  expect(() => bridge.readFile('/x')).toThrow(expect.objectContaining({ code: 'EIO' }));
});

test('non-2xx without an errno header falls back to EIO', () => {
  installFakeXhr();
  reply = { status: 500 };
  const bridge = createSyncFsXhrBridge('tok');
  expect(() => bridge.readFile('/x')).toThrow(expect.objectContaining({ code: 'EIO' }));
});

test('a 200 WITHOUT the x-slicc-fs marker (SPA fallback / stale SW) → EIO, not bytes', () => {
  installFakeXhr();
  reply = { status: 200, body: new TextEncoder().encode('<!doctype html>…'), noMarker: true };
  const bridge = createSyncFsXhrBridge('tok');
  expect(() => bridge.readFile('/workspace/a.txt')).toThrow(
    expect.objectContaining({ code: 'EIO' })
  );
});

test('a binary round-trip preserves non-UTF8 bytes', () => {
  installFakeXhr();
  const raw = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0xff]);
  reply = { status: 200, body: raw };
  const bridge = createSyncFsXhrBridge('tok');
  const out = bridge.readFile('/workspace/bin.dat');
  expect([...out]).toEqual([...raw]);
});

test('path with a space is encoded in the URL', () => {
  installFakeXhr();
  reply = { status: 200, body: new Uint8Array(0) };
  const bridge = createSyncFsXhrBridge('tok');
  bridge.readFile('/workspace/a b.txt');
  expect(lastSent?.url).toBe('/__slicc/fs-sync/workspace/a%20b.txt');
});

test('writeFile: a 200 WITHOUT the marker (SPA fallback / stale SW) → EIO, not success', () => {
  installFakeXhr();
  reply = { status: 200, noMarker: true };
  const bridge = createSyncFsXhrBridge('tok');
  // The dangerous half: a stale-SW SPA-fallback 200 on a POST must NOT be read
  // as "write succeeded" (the bytes went nowhere).
  expect(() => bridge.writeFile('/workspace/out.txt', new Uint8Array([1]))).toThrow(
    expect.objectContaining({ code: 'EIO' })
  );
});

test('paths with #, ?, % are per-segment percent-encoded (not dropped as fragment/query)', () => {
  installFakeXhr();
  reply = { status: 200, body: new Uint8Array(0) };
  const bridge = createSyncFsXhrBridge('tok');
  bridge.readFile('/workspace/a#b?c%d.txt');
  expect(lastSent?.url).toBe('/__slicc/fs-sync/workspace/a%23b%3Fc%25d.txt');
});
