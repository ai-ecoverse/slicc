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
  const handle = installSyncFsResponder(b);
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

test('errno results round-trip (unknown token → EACCES res)', async () => {
  const { a, b } = makeChannelPair();
  const received: Array<Record<string, unknown>> = [];
  a.addEventListener('message', (e) => received.push(e.data as Record<string, unknown>));
  installSyncFsResponder(b);

  a.postMessage({ type: 'sync-fs-req', id: '7', token: 'bogus', op: 'read', path: 'x' });

  await vi.waitFor(() => expect(received.some((m) => m.type === 'sync-fs-res')).toBe(true));
  const res = received.find((m) => m.type === 'sync-fs-res') as Record<string, unknown>;
  expect(res.ok).toBe(false);
  expect(res.errno).toBe('EACCES');
});

test('ignores non-sync-fs-req messages (no ack, no res)', () => {
  const { a, b } = makeChannelPair();
  const received: unknown[] = [];
  a.addEventListener('message', (e) => received.push(e.data));
  installSyncFsResponder(b);

  a.postMessage({ type: 'something-else', id: 'z' });
  a.postMessage({ notEvenTyped: true });

  expect(received).toEqual([]);
});

test('dispose stops the responder answering', async () => {
  const { a, b } = makeChannelPair();
  const received: Array<Record<string, unknown>> = [];
  a.addEventListener('message', (e) => received.push(e.data as Record<string, unknown>));
  const handle = installSyncFsResponder(b);
  handle.dispose();

  a.postMessage({ type: 'sync-fs-req', id: '2', token: 'bogus', op: 'read', path: 'x' });
  // Give any stray async dispatch a tick; nothing should come back.
  await new Promise((r) => setTimeout(r, 20));
  expect(received).toEqual([]);
});
