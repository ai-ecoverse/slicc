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

  expect(received[0]).toEqual({ type: 'sync-fs-ack', id: '1' });
  const res = received.find((m) => m.type === 'sync-fs-res') as Record<string, unknown>;
  expect(res.ok).toBe(true);
  expect(new TextDecoder().decode(res.bytes as Uint8Array)).toBe('hi');
  handle.dispose();
});

test('routes an exec-channel request to the exec dispatch, not the fs one', async () => {
  const { a, b } = makeChannelPair();
  const received: Array<Record<string, unknown>> = [];
  a.addEventListener('message', (e) => received.push(e.data as Record<string, unknown>));
  const handle = installSyncFsResponder({ channel: b });
  const exec = (async () => ({
    stdout: 'ran\n',
    stderr: '',
    exitCode: 0,
  })) as unknown as CommandContext['exec'];
  const token = mintSyncFsToken({ fs: {} as CommandContext['fs'], exec, cwd: '/workspace' });

  a.postMessage({ type: 'sync-fs-req', id: 'e1', token, channel: 'exec', command: 'echo ran' });

  await vi.waitFor(() => expect(received.some((m) => m.type === 'sync-fs-res')).toBe(true));
  const res = received.find((m) => m.type === 'sync-fs-res') as Record<string, unknown>;
  expect(res.ok).toBe(true);
  expect(res.json).toEqual({ stdout: 'ran\n', stderr: '', exitCode: 0 });
  handle.dispose();
});

test('an unowned token gets NO response on the exec channel either', async () => {
  const { a, b } = makeChannelPair();
  const received: Array<Record<string, unknown>> = [];
  a.addEventListener('message', (e) => received.push(e.data as Record<string, unknown>));
  const handle = installSyncFsResponder({ channel: b });

  a.postMessage({ type: 'sync-fs-req', id: 'e2', token: 'forged', channel: 'exec', command: 'ls' });

  await new Promise((r) => setTimeout(r, 20));
  expect(received).toEqual([]);
  handle.dispose();
});

test('an unowned token gets NO response (stays silent — owner/timeout answers)', async () => {
  const { a, b } = makeChannelPair();
  const received: Array<Record<string, unknown>> = [];
  a.addEventListener('message', (e) => received.push(e.data as Record<string, unknown>));
  installSyncFsResponder({ channel: b });

  a.postMessage({ type: 'sync-fs-req', id: '7', token: 'not-this-worker', op: 'read', path: 'x' });

  await new Promise((r) => setTimeout(r, 25));
  expect(received).toEqual([]);
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
  a.postMessage(req);

  await vi.waitFor(() => expect(received.some((m) => m.type === 'sync-fs-res')).toBe(true));
  await new Promise((r) => setTimeout(r, 20));
  expect(writes).toBe(1);

  expect(received.filter((m) => m.type === 'sync-fs-ack').length).toBe(2);
});

test('re-post AFTER settle replays the cached result and does NOT re-dispatch', async () => {
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

  await vi.waitFor(() => expect(received.some((m) => m.type === 'sync-fs-res')).toBe(true));
  a.postMessage(req);
  await new Promise((r) => setTimeout(r, 20));

  expect(reads).toBe(1);
  expect(received.filter((m) => m.type === 'sync-fs-res').length).toBe(2);
  expect(received.filter((m) => m.type === 'sync-fs-ack').length).toBe(2);
});

test('dispose stops the responder answering', async () => {
  const { a, b } = makeChannelPair();
  const received: Array<Record<string, unknown>> = [];
  a.addEventListener('message', (e) => received.push(e.data as Record<string, unknown>));
  const handle = installSyncFsResponder({ channel: b });
  const token = await tokenWithFile();
  handle.dispose();

  a.postMessage({ type: 'sync-fs-req', id: '2', token, op: 'read', path: 'hi.txt' });

  await new Promise((r) => setTimeout(r, 20));
  expect(received).toEqual([]);
});
