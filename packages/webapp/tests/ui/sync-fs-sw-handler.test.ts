import { expect, test } from 'vitest';
import {
  errnoToStatus,
  handleSyncFsRequest,
  parseSyncFsRequest,
  type SyncFsSwChannelLike,
} from '../../src/ui/sync-fs-sw-handler.js';

interface FakeResult {
  ok: boolean;
  bytes?: Uint8Array;
  errno?: string;
  message?: string;
}

/**
 * A channel that simulates the kernel responder: on a `sync-fs-req`, it acks
 * (next microtask) then posts the `responder(req)` result as `sync-fs-res`.
 * A `null` result → no res (used to exercise the timeout path).
 */
function respondingChannel(
  responder: (req: Record<string, unknown>) => FakeResult | null
): SyncFsSwChannelLike {
  const listeners = new Set<(e: MessageEvent) => void>();
  const emit = (data: unknown): void => {
    for (const l of [...listeners]) l({ data } as MessageEvent);
  };
  return {
    postMessage: (data: unknown) => {
      const req = data as Record<string, unknown>;
      if (req?.type !== 'sync-fs-req') return;
      queueMicrotask(() => emit({ type: 'sync-fs-ack', id: req.id }));
      const result = responder(req);
      if (result) queueMicrotask(() => emit({ type: 'sync-fs-res', id: req.id, ...result }));
    },
    addEventListener: (_t, l) => {
      listeners.add(l);
    },
    removeEventListener: (_t, l) => {
      listeners.delete(l);
    },
  };
}

test('ok read → 200 with raw bytes body', async () => {
  const ch = respondingChannel(() => ({ ok: true, bytes: new TextEncoder().encode('hi') }));
  const res = await handleSyncFsRequest(ch, { token: 't', op: 'read', path: '/workspace/a.txt' });
  expect(res.status).toBe(200);
  expect(res.headers.get('x-slicc-fs')).toBe('1'); // genuine-response marker
  expect(new TextDecoder().decode(new Uint8Array(await res.arrayBuffer()))).toBe('hi');
});

test('ok write → 200 empty body', async () => {
  const ch = respondingChannel(() => ({ ok: true }));
  const body = new TextEncoder().encode('x');
  const res = await handleSyncFsRequest(ch, { token: 't', op: 'write', path: '/w/b.txt', body });
  expect(res.status).toBe(200);
});

test('errno ENOENT → 404 + x-slicc-fs-errno header', async () => {
  const ch = respondingChannel(() => ({ ok: false, errno: 'ENOENT', message: 'nope' }));
  const res = await handleSyncFsRequest(ch, { token: 't', op: 'read', path: '/missing' });
  expect(res.status).toBe(404);
  expect(res.headers.get('x-slicc-fs-errno')).toBe('ENOENT');
});

test('errno EACCES → 403 (escape / bad token surfaces as 403)', async () => {
  const ch = respondingChannel(() => ({ ok: false, errno: 'EACCES', message: 'denied' }));
  const res = await handleSyncFsRequest(ch, { token: 'bad', op: 'read', path: '/secret' });
  expect(res.status).toBe(403);
  expect(res.headers.get('x-slicc-fs-errno')).toBe('EACCES');
});

test('timeout / no responder → 503 + EIO (fail closed, never hangs)', async () => {
  const silent: SyncFsSwChannelLike = {
    postMessage: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const res = await handleSyncFsRequest(
    silent,
    { token: 't', op: 'read', path: '/x' },
    { timeoutMs: 40, retryIntervalMs: 10 }
  );
  expect(res.status).toBe(503);
  expect(res.headers.get('x-slicc-fs-errno')).toBe('EIO');
});

test('errnoToStatus maps the known codes', () => {
  expect(errnoToStatus('ENOENT')).toBe(404);
  expect(errnoToStatus('EACCES')).toBe(403);
  expect(errnoToStatus('EISDIR')).toBe(400);
  expect(errnoToStatus('EIO')).toBe(503);
  expect(errnoToStatus('EWHATEVER')).toBe(500);
});

test('parseSyncFsRequest: GET → read with token + decoded path', async () => {
  const parsed = await parseSyncFsRequest({
    url: 'https://www.sliccy.ai/__slicc/fs-sync/workspace/a.txt',
    method: 'GET',
    headers: { get: (n) => (n === 'x-slicc-fs-token' ? 'tok123' : null) },
    arrayBuffer: async () => new ArrayBuffer(0),
  });
  expect(parsed).toEqual({ token: 'tok123', op: 'read', path: '/workspace/a.txt' });
});

test('parseSyncFsRequest: POST → write with body', async () => {
  const body = new TextEncoder().encode('hello');
  const parsed = await parseSyncFsRequest({
    url: 'https://www.sliccy.ai/__slicc/fs-sync/workspace/b.txt',
    method: 'POST',
    headers: { get: () => 'tok' },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  });
  expect(parsed?.op).toBe('write');
  expect(new TextDecoder().decode(parsed?.body as Uint8Array)).toBe('hello');
});

test('parseSyncFsRequest: non-route → null', async () => {
  const parsed = await parseSyncFsRequest({
    url: 'https://www.sliccy.ai/preview/workspace/a.txt',
    method: 'GET',
    headers: { get: () => null },
    arrayBuffer: async () => new ArrayBuffer(0),
  });
  expect(parsed).toBeNull();
});
