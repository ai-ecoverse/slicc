import type { CommandContext } from 'just-bash';
import 'fake-indexeddb/auto';
import { expect, test, vi } from 'vitest';
import { VirtualFS } from '../../../src/fs/virtual-fs.js';
import {
  installSyncFsResponder,
  type SyncFsChannelLike,
} from '../../../src/kernel/realm/sync-fs-responder.js';
import { mintSyncFsToken } from '../../../src/kernel/realm/sync-fs-token-registry.js';
import { VfsAdapter } from '../../../src/shell/vfs-adapter.js';

let counter = 0;

/** A paired in-memory channel: a post on one side is heard by the other. */
function makeChannelPair(): { a: SyncFsChannelLike; b: SyncFsChannelLike } {
  const aListeners = new Set<(e: MessageEvent) => void>();
  const bListeners = new Set<(e: MessageEvent) => void>();
  const a: SyncFsChannelLike = {
    postMessage: (d) => {
      for (const l of [...bListeners]) l({ data: d } as MessageEvent);
    },
    addEventListener: (_t, l) => {
      aListeners.add(l);
    },
    removeEventListener: (_t, l) => {
      aListeners.delete(l);
    },
  };
  const b: SyncFsChannelLike = {
    postMessage: (d) => {
      for (const l of [...aListeners]) l({ data: d } as MessageEvent);
    },
    addEventListener: (_t, l) => {
      bListeners.add(l);
    },
    removeEventListener: (_t, l) => {
      bListeners.delete(l);
    },
  };
  return { a, b };
}

async function tokenWithFile(): Promise<string> {
  const vfs = await VirtualFS.create({ dbName: `sfr-${counter++}`, wipe: true });
  await vfs.mkdir('/workspace', { recursive: true });
  await vfs.writeFile('/workspace/hi.txt', 'hi');
  const fs = new VfsAdapter(vfs) as unknown as CommandContext['fs'];
  return mintSyncFsToken({ fs, cwd: '/workspace' });
}

test('responds to a sync-fs-req: acks immediately, then posts res with bytes', async () => {
  const { a, b } = makeChannelPair();
  const received: Array<Record<string, unknown>> = [];
  a.addEventListener('message', (e) => received.push(e.data as Record<string, unknown>));
  const handle = installSyncFsResponder({ channel: b });
  const token = await tokenWithFile();

  a.postMessage({ type: 'sync-fs-req', id: '1', token, op: 'read', path: 'hi.txt' });

  await vi.waitFor(() => expect(received.some((m) => m.type === 'sync-fs-res')).toBe(true));
  // Ack is first (cold-start race guard), before the async dispatch resolves.
  expect(received[0]).toEqual({ type: 'sync-fs-ack', id: '1' });
  const res = received.find((m) => m.type === 'sync-fs-res') as Record<string, unknown>;
  expect(res.ok).toBe(true);
  expect(new TextDecoder().decode(res.bytes as Uint8Array)).toBe('hi');
  handle.dispose();
});

test('an unowned token gets NO response (stays silent — owner/timeout answers)', async () => {
  // Origin-scoped channel: a token this worker doesn't own (another worker's,
  // or forged/revoked) must NOT be answered here, so we can't win a race with
  // a spurious EACCES. It fails closed via the SW handler's timeout instead.
  const { a, b } = makeChannelPair();
  const received: Array<Record<string, unknown>> = [];
  a.addEventListener('message', (e) => received.push(e.data as Record<string, unknown>));
  installSyncFsResponder({ channel: b });

  a.postMessage({ type: 'sync-fs-req', id: '7', token: 'not-this-worker', op: 'read', path: 'x' });

  await new Promise((r) => setTimeout(r, 25));
  expect(received).toEqual([]); // no ack, no res
});

test("an owned token's errno result round-trips (missing file → ENOENT res)", async () => {
  const { a, b } = makeChannelPair();
  const received: Array<Record<string, unknown>> = [];
  a.addEventListener('message', (e) => received.push(e.data as Record<string, unknown>));
  installSyncFsResponder({ channel: b });
  const token = await tokenWithFile();

  a.postMessage({ type: 'sync-fs-req', id: '8', token, op: 'read', path: 'missing.txt' });

  await vi.waitFor(() => expect(received.some((m) => m.type === 'sync-fs-res')).toBe(true));
  const res = received.find((m) => m.type === 'sync-fs-res') as Record<string, unknown>;
  expect(res.ok).toBe(false);
  expect(res.errno).toBe('ENOENT');
});

test('ignores non-sync-fs-req messages (no ack, no res)', () => {
  const { a, b } = makeChannelPair();
  const received: unknown[] = [];
  a.addEventListener('message', (e) => received.push(e.data));
  installSyncFsResponder({ channel: b });

  a.postMessage({ type: 'something-else', id: 'z' });
  a.postMessage({ notEvenTyped: true });

  expect(received).toEqual([]);
});

test('re-posted request id is dispatched AT MOST ONCE (idempotency, Con#1)', async () => {
  // The SW re-posts the same id until it processes the ack; under load a re-post
  // can arrive before the ack is processed. The op must NOT run twice (a double
  // write / double sudo prompt / stale-clobber of a concurrent writer).
  const { a, b } = makeChannelPair();
  let writes = 0;
  const fs = {
    resolvePath: (cwd: string, p: string) => (p.startsWith('/') ? p : `${cwd}/${p}`),
    writeFile: async () => {
      writes++;
    },
  } as unknown as CommandContext['fs'];
  const token = mintSyncFsToken({ fs, cwd: '/workspace' });
  const received: Array<Record<string, unknown>> = [];
  a.addEventListener('message', (e) => received.push(e.data as Record<string, unknown>));
  installSyncFsResponder({ channel: b });

  const req = {
    type: 'sync-fs-req',
    id: 'dup',
    token,
    op: 'write',
    path: 'x',
    body: new Uint8Array([1]),
  };
  a.postMessage(req);
  a.postMessage(req); // re-post while the first dispatch is still in-flight

  await vi.waitFor(() => expect(received.some((m) => m.type === 'sync-fs-res')).toBe(true));
  await new Promise((r) => setTimeout(r, 20));
  expect(writes).toBe(1); // dispatched exactly once despite the re-post
  // Both posts are acked (so the SW stops retrying regardless of which it saw).
  expect(received.filter((m) => m.type === 'sync-fs-ack').length).toBe(2);
});

test('re-post AFTER settle replays the cached result and does NOT re-dispatch', async () => {
  // A lost-ack retry can arrive after the first dispatch already settled. The
  // responder must re-ack + replay the CACHED result, never re-run the op
  // (exercises the `existing.result` replay branch the in-flight dedupe test
  // doesn't reach; the dedupe TTL is what keeps this entry alive to answer).
  const { a, b } = makeChannelPair();
  let reads = 0;
  const fs = {
    resolvePath: (cwd: string, p: string) => (p.startsWith('/') ? p : `${cwd}/${p}`),
    readFileBuffer: async () => {
      reads++;
      return new TextEncoder().encode('data');
    },
  } as unknown as CommandContext['fs'];
  const token = mintSyncFsToken({ fs, cwd: '/workspace' });
  const received: Array<Record<string, unknown>> = [];
  a.addEventListener('message', (e) => received.push(e.data as Record<string, unknown>));
  installSyncFsResponder({ channel: b });

  const req = { type: 'sync-fs-req', id: 'settle', token, op: 'read', path: 'x' };
  a.postMessage(req);
  // Let the FIRST dispatch fully settle (result cached), THEN re-post.
  await vi.waitFor(() => expect(received.some((m) => m.type === 'sync-fs-res')).toBe(true));
  a.postMessage(req);
  await new Promise((r) => setTimeout(r, 20));

  expect(reads).toBe(1); // NOT re-dispatched
  expect(received.filter((m) => m.type === 'sync-fs-res').length).toBe(2); // original + replay
  expect(received.filter((m) => m.type === 'sync-fs-ack').length).toBe(2);
});

test('dispose stops the responder answering', async () => {
  const { a, b } = makeChannelPair();
  const received: Array<Record<string, unknown>> = [];
  a.addEventListener('message', (e) => received.push(e.data as Record<string, unknown>));
  const handle = installSyncFsResponder({ channel: b });
  const token = await tokenWithFile(); // owned → WOULD be answered if still listening
  handle.dispose();

  a.postMessage({ type: 'sync-fs-req', id: '2', token, op: 'read', path: 'hi.txt' });
  // Give any stray async dispatch a tick; the listener is detached → nothing.
  await new Promise((r) => setTimeout(r, 20));
  expect(received).toEqual([]);
});
