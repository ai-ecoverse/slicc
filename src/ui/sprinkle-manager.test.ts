import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VirtualFS } from '../fs/virtual-fs.js';
import { SprinkleManager } from './sprinkle-manager.js';
import type { LickEvent } from '../scoops/lick-manager.js';

// Mock BroadcastChannel for Node test environment
class MockBroadcastChannel {
  name: string;
  onmessage: ((event: MessageEvent) => void) | null = null;
  private static channels = new Map<string, Set<MockBroadcastChannel>>();

  constructor(name: string) {
    this.name = name;
    if (!MockBroadcastChannel.channels.has(name)) {
      MockBroadcastChannel.channels.set(name, new Set());
    }
    MockBroadcastChannel.channels.get(name)!.add(this);
  }

  postMessage(data: unknown): void {
    const peers = MockBroadcastChannel.channels.get(this.name);
    if (!peers) return;
    for (const peer of peers) {
      if (peer !== this && peer.onmessage) {
        peer.onmessage(new MessageEvent('message', { data }));
      }
    }
  }

  close(): void {
    MockBroadcastChannel.channels.get(this.name)?.delete(this);
  }

  static reset(): void {
    MockBroadcastChannel.channels.clear();
  }
}

// Install global BroadcastChannel mock
(globalThis as any).BroadcastChannel = MockBroadcastChannel;

describe('SprinkleManager', () => {
  let vfs: VirtualFS;
  let dbCounter = 0;
  let lickHandler: (event: LickEvent) => void;
  let addSprinkle: ReturnType<typeof vi.fn>;
  let removeSprinkle: ReturnType<typeof vi.fn>;
  let mgr: SprinkleManager;

  beforeEach(async () => {
    MockBroadcastChannel.reset();
    vfs = await VirtualFS.create({
      dbName: `test-sprinkle-manager-${dbCounter++}`,
      wipe: true,
    });
    lickHandler = vi.fn() as unknown as (event: LickEvent) => void;
    addSprinkle = vi.fn();
    removeSprinkle = vi.fn();
    mgr = new SprinkleManager(vfs, lickHandler, {
      addSprinkle: addSprinkle as unknown as (name: string, title: string, element: HTMLElement) => void,
      removeSprinkle: removeSprinkle as unknown as (name: string) => void,
    });
  });

  afterEach(() => {
    MockBroadcastChannel.reset();
  });

  it('refresh discovers available sprinkles', async () => {
    await vfs.writeFile('/shared/sprinkles/dash/dash.shtml', '<title>Dashboard</title><div>hi</div>');
    await mgr.refresh();
    const sprinkles = mgr.available();
    expect(sprinkles.length).toBe(1);
    expect(sprinkles[0].name).toBe('dash');
    expect(sprinkles[0].title).toBe('Dashboard');
  });

  it('available() returns empty when no sprinkles', async () => {
    await mgr.refresh();
    expect(mgr.available()).toEqual([]);
  });

  it('opened() returns empty initially', () => {
    expect(mgr.opened()).toEqual([]);
  });

  it('open throws for unknown sprinkle', async () => {
    await expect(mgr.open('nonexistent')).rejects.toThrow('Sprinkle not found: nonexistent');
  });

  it('sendToSprinkle does not throw for closed sprinkle', () => {
    expect(() => mgr.sendToSprinkle('unknown', {})).not.toThrow();
  });

  // ── Playground discovery tests ──────────────────────────────────────

  describe('playground discovery', () => {
    it('registers playground on playground-ready', () => {
      mgr.startPlaygroundDiscovery();

      // Simulate a playground tab announcing itself
      const pg = new MockBroadcastChannel('slicc-playground');
      pg.postMessage({ type: 'playground-ready', id: '/app.html:abc', path: '/app.html' });

      // sendToSprinkle with playground: prefix should not warn
      // (playground is registered)
      mgr.sendToSprinkle('playground:/app.html:abc', { hello: true });

      pg.close();
    });

    it('routes playground-lick to lickHandler', () => {
      mgr.startPlaygroundDiscovery();

      const pg = new MockBroadcastChannel('slicc-playground');
      pg.postMessage({ type: 'playground-ready', id: '/app.html:abc', path: '/app.html' });
      pg.postMessage({ type: 'playground-lick', id: '/app.html:abc', action: 'click', data: { x: 10 } });

      expect(lickHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'sprinkle',
          sprinkleName: 'playground:/app.html:abc',
          body: { action: 'click', data: { x: 10 } },
        }),
      );

      pg.close();
    });

    it('sendToSprinkle with playground: prefix sends playground-update', () => {
      mgr.startPlaygroundDiscovery();

      const pg = new MockBroadcastChannel('slicc-playground');
      const received: unknown[] = [];
      pg.onmessage = (e) => {
        if (e.data?.type === 'playground-update') received.push(e.data);
      };

      // Register first
      const reg = new MockBroadcastChannel('slicc-playground');
      reg.postMessage({ type: 'playground-ready', id: '/app.html:xyz', path: '/app.html' });

      // Send update from agent
      mgr.sendToSprinkle('playground:/app.html:xyz', { result: 42 });

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual({
        type: 'playground-update',
        targetId: '/app.html:xyz',
        data: { result: 42 },
      });

      pg.close();
      reg.close();
    });

    it('resolves playground by path prefix', () => {
      mgr.startPlaygroundDiscovery();

      const reg = new MockBroadcastChannel('slicc-playground');
      reg.postMessage({ type: 'playground-ready', id: '/app.html:xyz', path: '/app.html' });

      const pg = new MockBroadcastChannel('slicc-playground');
      const received: unknown[] = [];
      pg.onmessage = (e) => {
        if (e.data?.type === 'playground-update') received.push(e.data);
      };

      // Send using just the path — should resolve to the full ID
      mgr.sendToSprinkle('playground:/app.html', { data: 'test' });

      expect(received).toHaveLength(1);
      expect((received[0] as any).targetId).toBe('/app.html:xyz');

      pg.close();
      reg.close();
    });

    it('unregisters playground on playground-close', () => {
      mgr.startPlaygroundDiscovery();

      const pg = new MockBroadcastChannel('slicc-playground');
      pg.postMessage({ type: 'playground-ready', id: '/app.html:abc', path: '/app.html' });
      pg.postMessage({ type: 'playground-close', id: '/app.html:abc' });

      // Subsequent sends should warn (playground gone)
      const received: unknown[] = [];
      const pg2 = new MockBroadcastChannel('slicc-playground');
      pg2.onmessage = (e) => {
        if (e.data?.type === 'playground-update') received.push(e.data);
      };

      mgr.sendToSprinkle('playground:/app.html:abc', { data: 'test' });
      expect(received).toHaveLength(0);

      pg.close();
      pg2.close();
    });

    it('handles playground-readfile requests', async () => {
      await vfs.writeFile('/shared/data.txt', 'hello world');
      mgr.startPlaygroundDiscovery();

      const pg = new MockBroadcastChannel('slicc-playground');
      pg.postMessage({ type: 'playground-ready', id: 'pg1', path: '/test.html' });

      const responses: unknown[] = [];
      pg.onmessage = (e) => {
        if (e.data?.type === 'playground-readfile-response') responses.push(e.data);
      };

      pg.postMessage({
        type: 'playground-readfile',
        id: 'pg1',
        requestId: 'rf-001',
        path: '/shared/data.txt',
      });

      // Wait for async readFile to complete
      await new Promise((r) => setTimeout(r, 50));

      expect(responses).toHaveLength(1);
      expect((responses[0] as any).content).toBe('hello world');
      expect((responses[0] as any).requestId).toBe('rf-001');

      pg.close();
    });

    it('startPlaygroundDiscovery is idempotent', () => {
      mgr.startPlaygroundDiscovery();
      mgr.startPlaygroundDiscovery(); // should not throw or create duplicate channels
    });
  });
});
