import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// BroadcastChannel mock — Node doesn't provide one.
// We simulate the real behaviour: posting on one channel delivers to all
// *other* channels with the same name (never to the sender itself).
// ---------------------------------------------------------------------------
const channelRegistry = new Map<string, Set<MockBroadcastChannel>>();

class MockBroadcastChannel {
  readonly name: string;
  onmessage: ((ev: MessageEvent) => void) | null = null;

  constructor(name: string) {
    this.name = name;
    if (!channelRegistry.has(name)) channelRegistry.set(name, new Set());
    channelRegistry.get(name)!.add(this);
  }

  postMessage(data: unknown): void {
    const peers = channelRegistry.get(this.name);
    if (!peers) return;
    for (const peer of peers) {
      if (peer === this) continue; // real BC never delivers to sender
      peer.onmessage?.({ data } as MessageEvent);
    }
  }

  close(): void {
    channelRegistry.get(this.name)?.delete(this);
  }
}

// Install globally before any VirtualFS import
(globalThis as any).BroadcastChannel = MockBroadcastChannel;

// Dynamic import so the module sees the global BroadcastChannel
const { VirtualFS } = await import('../../src/fs/virtual-fs.js');

describe('VirtualFS mount-point sync via BroadcastChannel', () => {
  let vfsA: InstanceType<typeof VirtualFS>;
  let vfsB: InstanceType<typeof VirtualFS>;

  beforeEach(async () => {
    channelRegistry.clear();
    vfsA = await VirtualFS.create({ dbName: 'sync-test', wipe: true });
    vfsB = await VirtualFS.create({ dbName: 'sync-test' });
  });

  afterEach(async () => {
    await vfsA.dispose();
    await vfsB.dispose();
    channelRegistry.clear();
    await new Promise((r) => setTimeout(r, 600));
  });

  it('syncs mount from A to B', async () => {
    const fakeHandle = { kind: 'directory', name: 'fake' } as unknown as FileSystemDirectoryHandle;
    await vfsA.mount('/mnt/real', fakeHandle);

    expect(vfsA.listMounts()).toContain('/mnt/real');
    expect(vfsB.listMounts()).toContain('/mnt/real');
  });

  it('syncs unmount from A to B', async () => {
    const fakeHandle = { kind: 'directory', name: 'fake' } as unknown as FileSystemDirectoryHandle;
    await vfsA.mount('/mnt/real', fakeHandle);
    expect(vfsB.listMounts()).toContain('/mnt/real');

    vfsA.unmount('/mnt/real');
    expect(vfsA.listMounts()).not.toContain('/mnt/real');
    expect(vfsB.listMounts()).not.toContain('/mnt/real');
  });

  it('does not sync between different dbNames', async () => {
    const vfsOther = await VirtualFS.create({ dbName: 'other-db', wipe: true });
    const fakeHandle = { kind: 'directory', name: 'fake' } as unknown as FileSystemDirectoryHandle;
    await vfsA.mount('/mnt/real', fakeHandle);

    expect(vfsOther.listMounts()).not.toContain('/mnt/real');
    await vfsOther.dispose();
  });

  it('stops syncing after dispose', async () => {
    const fakeHandle = { kind: 'directory', name: 'fake' } as unknown as FileSystemDirectoryHandle;
    await vfsB.dispose();

    await vfsA.mount('/mnt/real', fakeHandle);
    // vfsB was disposed, so it shouldn't receive the mount — but we can't
    // check vfsB.listMounts() after dispose. Instead verify the channel was closed:
    const channelSet = channelRegistry.get('vfs-mount-sync:sync-test');
    // Only vfsA's channel should remain
    expect(channelSet?.size ?? 0).toBe(1);

    // Re-create vfsB so afterEach cleanup works
    vfsB = await VirtualFS.create({ dbName: 'sync-test' });
  });
});
