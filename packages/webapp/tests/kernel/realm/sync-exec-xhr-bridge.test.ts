import { afterEach, expect, test, vi } from 'vitest';
import { createSyncExecXhrBridge } from '../../../src/kernel/realm/sync-exec-xhr-bridge.js';
import { SyncFsCache } from '../../../src/kernel/realm/sync-fs-cache.js';
import { SYNC_EXEC_MAX_TIMEOUT_MS } from '../../../src/kernel/realm/sync-fs-wire.js';
import type { SyncFsXhrMutatingBridge } from '../../../src/kernel/realm/sync-fs-xhr-bridge.js';

interface FakeReply {
  status: number;
  body?: Uint8Array;
  errno?: string;
  noMarker?: boolean;
}

interface SentRecord {
  method: string;
  url: string;
  token: string | null;
  body: string;
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
  send(body?: Uint8Array): void {
    lastSent = {
      method: this.method,
      url: this.url,
      token: this.headers['x-slicc-fs-token'] ?? null,
      body: body ? new TextDecoder().decode(body) : '',
    };
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

function okReply(value: unknown): FakeReply {
  return { status: 200, body: new TextEncoder().encode(JSON.stringify(value)) };
}

function installFakeXhr(): void {
  vi.stubGlobal('XMLHttpRequest', FakeXHR as unknown as typeof XMLHttpRequest);
}

/** Records every live fs op the flush-before path drives. */
function recordingFsBridge(log: string[]): SyncFsXhrMutatingBridge {
  return {
    readFile: () => new Uint8Array(0),
    writeFile: (p) => log.push(`write ${p}`),
    stat: () => ({ isFile: true, isDirectory: false, size: 0 }),
    lstat: () => ({ isFile: true, isDirectory: false, size: 0 }),
    readdir: () => [],
    exists: () => true,
    mkdir: (p) => log.push(`mkdir ${p}`),
    rm: (p) => log.push(`rm ${p}`),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  reply = { status: 200 };
  lastSent = null;
});

test('run POSTs the JSON envelope to the exec route with the token', () => {
  installFakeXhr();
  reply = okReply({ stdout: 'hi\n', stderr: '', exitCode: 0 });
  const bridge = createSyncExecXhrBridge('tok-exec');
  expect(bridge.run('echo hi')).toEqual({ stdout: 'hi\n', stderr: '', exitCode: 0 });
  expect(lastSent?.method).toBe('POST');
  expect(lastSent?.url).toBe('/__slicc/exec-sync');
  expect(lastSent?.token).toBe('tok-exec');
  expect(JSON.parse(lastSent!.body)).toMatchObject({ command: 'echo hi', channel: 'exec' });
});

test('argv, stdin and timeout ride the envelope', () => {
  installFakeXhr();
  reply = okReply({ stdout: '', stderr: '', exitCode: 0 });
  createSyncExecXhrBridge('t').run(['cat'], { input: 'piped', timeout: 1234 });
  expect(JSON.parse(lastSent!.body)).toMatchObject({
    command: ['cat'],
    stdin: 'piped',
    timeoutMs: 1234,
  });
});

test("Node's `{ timeout: 0 }` becomes the default budget, not a 0 transport budget", () => {
  // 0 means "no timeout" in Node. Sending it verbatim made the SW use its
  // 120s fallback while the XHR gave up after only the margin, so any command
  // slower than the margin failed early with EIO.
  installFakeXhr();
  reply = okReply({ stdout: '', stderr: '', exitCode: 0 });
  createSyncExecXhrBridge('t', { timeoutMs: 60_000 }).run('slow', { timeout: 0 });
  expect(JSON.parse(lastSent!.body).timeoutMs).toBe(60_000);
});

test('a caller budget above the wire ceiling is clamped before it reaches the XHR', () => {
  installFakeXhr();
  reply = okReply({ stdout: '', stderr: '', exitCode: 0 });
  createSyncExecXhrBridge('t').run('forever', { timeout: Number.MAX_SAFE_INTEGER });
  expect(JSON.parse(lastSent!.body).timeoutMs).toBe(SYNC_EXEC_MAX_TIMEOUT_MS);
});

test('an errno reply throws an Error carrying .code', () => {
  installFakeXhr();
  reply = { status: 403, errno: 'EACCES' };
  expect(() => createSyncExecXhrBridge('t').run('sudo rm -rf /')).toThrow(
    expect.objectContaining({ code: 'EACCES' })
  );
});

test('a 2xx without the marker header fails closed as EIO (SPA fallback)', () => {
  installFakeXhr();
  reply = { ...okReply({ stdout: '', stderr: '', exitCode: 0 }), noMarker: true };
  expect(() => createSyncExecXhrBridge('t').run('ls')).toThrow(
    expect.objectContaining({ code: 'EIO' })
  );
});

test('a malformed result payload fails closed as EIO', () => {
  installFakeXhr();
  reply = okReply({ stdout: 'x' }); // missing stderr / exitCode
  expect(() => createSyncExecXhrBridge('t').run('ls')).toThrow(
    expect.objectContaining({ code: 'EIO' })
  );
});

test('COHERENCE: pending cache mutations are flushed live before the command runs', () => {
  installFakeXhr();
  reply = okReply({ stdout: '', stderr: '', exitCode: 0 });
  const syncFs = new SyncFsCache({
    entries: [{ path: '/workspace/old.txt', content: new Uint8Array(1), isDirectory: false }],
  });
  syncFs.writeFile('/workspace/new.txt', new TextEncoder().encode('fresh'));
  syncFs.mkdir('/workspace/d', true);
  syncFs.rm('/workspace/old.txt');
  const log: string[] = [];
  const bridge = createSyncExecXhrBridge('t', { syncFs, fsBridge: recordingFsBridge(log) });

  bridge.run('build');

  // Deletes first, then creates — matching applySyncFsMutations' ordering.
  expect(log[0]).toBe('rm /workspace/old.txt');
  expect(log).toContain('mkdir /workspace/d');
  expect(log).toContain('write /workspace/new.txt');
  // Baseline rebased, so the end-of-script flush won't re-apply them.
  const m = syncFs.getMutations();
  expect(m.created.length + m.modified.length + m.deleted.length).toBe(0);
});

test('COHERENCE: the cache is invalidated after the command, even when it throws', () => {
  installFakeXhr();
  const syncFs = new SyncFsCache({
    entries: [{ path: '/workspace/a.txt', content: new Uint8Array(1), isDirectory: false }],
  });
  syncFs.readFile('/workspace/a.txt'); // marks the cache as used
  const bridge = createSyncExecXhrBridge('t', { syncFs, fsBridge: recordingFsBridge([]) });

  reply = { status: 503, errno: 'EIO' };
  expect(() => bridge.run('boom')).toThrow();
  // Invalidated → the entry is gone, so a later read falls through to the live
  // fs bridge instead of returning stale post-exec bytes.
  expect(syncFs.exists('/workspace/a.txt')).toBe(false);
});

test('an untouched sync cache skips the coherence dance entirely', () => {
  installFakeXhr();
  reply = okReply({ stdout: '', stderr: '', exitCode: 0 });
  const syncFs = new SyncFsCache({ entries: [] });
  const log: string[] = [];
  createSyncExecXhrBridge('t', { syncFs, fsBridge: recordingFsBridge(log) }).run('ls');
  expect(log).toEqual([]);
});
