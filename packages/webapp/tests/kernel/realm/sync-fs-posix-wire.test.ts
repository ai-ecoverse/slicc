import { afterEach, expect, test, vi } from 'vitest';
import type { SyncFsResult } from '../../../src/kernel/realm/sync-fs-dispatch.js';
import { createSyncFsXhrBridge } from '../../../src/kernel/realm/sync-fs-xhr-bridge.js';
import {
  createSyncFsSabBridge,
  type SyncSabTransport,
} from '../../../src/kernel/realm/sync-sab-bridge.js';
import type { SyncSabRequestBody } from '../../../src/kernel/realm/sync-sab-wire.js';
import { parseSyncFsRequest } from '../../../src/ui/sync-fs-sw-handler.js';

interface Sent {
  method: string;
  url: string;
  body?: Uint8Array;
}

let sent: Sent[] = [];
let replyJson: unknown;

class FakeXHR {
  method = '';
  url = '';
  responseType = '';
  timeout = 0;
  status = 0;
  response: ArrayBuffer = new ArrayBuffer(0);
  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(): void {}
  send(body?: Uint8Array): void {
    sent.push({ method: this.method, url: this.url, ...(body ? { body } : {}) });
    this.status = 200;
    if (replyJson !== undefined) {
      const b = new TextEncoder().encode(JSON.stringify(replyJson));
      this.response = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    }
  }
  getResponseHeader(name: string): string | null {
    return name.toLowerCase() === 'x-slicc-fs' ? '1' : null;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  sent = [];
  replyJson = undefined;
});

function parse(s: Sent) {
  const body = s.body ?? new Uint8Array(0);
  return parseSyncFsRequest({
    url: new URL(s.url, 'https://www.sliccy.ai').href,
    method: s.method,
    headers: { get: () => 'tok' },
    arrayBuffer: async () =>
      body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
  });
}

test('SW route: every POSIX op round-trips through the parser', async () => {
  vi.stubGlobal('XMLHttpRequest', FakeXHR as unknown as typeof XMLHttpRequest);
  const bridge = createSyncFsXhrBridge('tok');
  bridge.rename('/w/a', '/w/b c');
  bridge.unlink('/w/a');
  bridge.rmdir('/w/d');
  bridge.symlink('../t', '/w/ln');
  bridge.chmod('/w/a', 0o755);
  bridge.utimes('/w/a', 1_000, 2_000);
  replyJson = '../t';
  expect(bridge.readlink('/w/ln')).toBe('../t');

  const parsed = await Promise.all(sent.map(parse));
  expect(parsed).toEqual([
    { token: 'tok', op: 'rename', path: '/w/a', arg2: '/w/b c' },
    { token: 'tok', op: 'unlink', path: '/w/a' },
    { token: 'tok', op: 'rmdir', path: '/w/d' },
    { token: 'tok', op: 'symlink', path: '/w/ln', arg2: '../t' },
    { token: 'tok', op: 'chmod', path: '/w/a', mode: 0o755 },
    { token: 'tok', op: 'utimes', path: '/w/a', atimeMs: 1_000, mtimeMs: 2_000 },
    { token: 'tok', op: 'readlink', path: '/w/ln' },
  ]);
});

test('SW route: stat passes mode + mtimeMs through, and still parses a 4-field reply', () => {
  vi.stubGlobal('XMLHttpRequest', FakeXHR as unknown as typeof XMLHttpRequest);
  const bridge = createSyncFsXhrBridge('tok');
  replyJson = { isFile: true, isDirectory: false, size: 3, mode: 0o100644, mtimeMs: 42 };
  expect(bridge.stat('/w/a')).toEqual({
    isFile: true,
    isDirectory: false,
    isSymbolicLink: undefined,
    size: 3,
    mode: 0o100644,
    mtimeMs: 42,
  });
  replyJson = { isFile: true, isDirectory: false, size: 3 };
  expect(bridge.lstat('/w/a')).not.toHaveProperty('mode');
});

test('SW parser drops mistyped or unparsable POSIX arguments', async () => {
  const hostile = (body: string) =>
    parse({
      method: 'POST',
      url: '/__slicc/fs-sync/w/a?op=chmod',
      body: new TextEncoder().encode(body),
    });
  expect(await hostile('{"mode":"777","arg2":5,"mtimeMs":null}')).toEqual({
    token: 'tok',
    op: 'chmod',
    path: '/w/a',
  });
  expect(await hostile('not json')).toEqual({ token: 'tok', op: 'chmod', path: '/w/a' });
  expect(await hostile('{"mtimeMs": 1e400}')).toEqual({ token: 'tok', op: 'chmod', path: '/w/a' });
});

test('SAB transport: the POSIX ops send the dispatcher request shape', () => {
  const reqs: SyncSabRequestBody[] = [];
  let next: SyncFsResult = { ok: true, kind: 'void' };
  const transport: SyncSabTransport = {
    call(req) {
      reqs.push(req);
      return next;
    },
  };
  const bridge = createSyncFsSabBridge(transport);
  bridge.rename('/a', '/b');
  bridge.unlink('/a');
  bridge.rmdir('/d');
  bridge.symlink('t', '/ln');
  bridge.chmod('/a', 0o700);
  bridge.utimes('/a', 5, 6);
  next = { ok: true, kind: 'json', json: 't' };
  expect(bridge.readlink('/ln')).toBe('t');
  expect(reqs).toEqual([
    { op: 'rename', path: '/a', arg2: '/b' },
    { op: 'unlink', path: '/a' },
    { op: 'rmdir', path: '/d' },
    { op: 'symlink', path: '/ln', arg2: 't' },
    { op: 'chmod', path: '/a', mode: 0o700 },
    { op: 'utimes', path: '/a', atimeMs: 5, mtimeMs: 6 },
    { op: 'readlink', path: '/ln' },
  ]);

  next = { ok: false, errno: 'ENOTEMPTY', message: 'x' };
  expect(() => bridge.rmdir('/d')).toThrow(expect.objectContaining({ code: 'ENOTEMPTY' }));
  next = { ok: true, kind: 'json', json: 42 };
  expect(() => bridge.readlink('/ln')).toThrow(expect.objectContaining({ code: 'EIO' }));
});
