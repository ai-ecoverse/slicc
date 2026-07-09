import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LickEvent } from '../../src/scoops/lick-manager.js';

// Capture the onEvent (navigate) + onDiscovery + isDiscoveryEnabled
// NavigationWatcher is constructed with, and drive them.
let captured: ((e: unknown) => void) | null = null;
let capturedDiscovery: ((e: unknown) => void) | null = null;
let capturedIsEnabled: (() => boolean) | null = null;
vi.mock('../../src/cdp/navigation-watcher.js', () => ({
  NavigationWatcher: class {
    onEvent: (e: unknown) => void;
    constructor(
      _t: unknown,
      onEvent: (e: unknown) => void,
      options?: { onDiscovery?: (e: unknown) => void; isDiscoveryEnabled?: () => boolean }
    ) {
      this.onEvent = onEvent;
      captured = onEvent;
      capturedDiscovery = options?.onDiscovery ?? null;
      capturedIsEnabled = options?.isDiscoveryEnabled ?? null;
    }
    start() {}
    stop() {}
  },
}));

function makeMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('startFollowerNavigateWatcher', () => {
  it('forwards a navigate lick built from the NavigationEvent to the current sync', async () => {
    const { startFollowerNavigateWatcher } = await import(
      '../../src/ui/follower-navigate-watcher.js'
    );
    const forwardLick = vi.fn((_event: LickEvent) => true);
    startFollowerNavigateWatcher({} as never, () => ({ forwardLick }));
    captured!({
      url: 'https://x/',
      verb: 'handoff',
      target: 'https://x/',
      instruction: 'go',
      links: [],
      targetId: 't1',
    });
    expect(forwardLick).toHaveBeenCalledTimes(1);
    const lick = forwardLick.mock.calls[0]![0];
    expect(lick.type).toBe('navigate');
    expect(lick.navigateUrl).toBe('https://x/');
    const body = lick.body as Record<string, unknown>;
    expect(body.verb).toBe('handoff');
    expect(body.instruction).toBe('go');
  });

  it('omits branch/path/title/instruction from the body when undefined', async () => {
    const { startFollowerNavigateWatcher } = await import(
      '../../src/ui/follower-navigate-watcher.js'
    );
    const forwardLick = vi.fn((_event: LickEvent) => true);
    startFollowerNavigateWatcher({} as never, () => ({ forwardLick }));
    captured!({
      url: 'https://x/',
      verb: 'navigate',
      target: 'https://x/',
      links: [],
      targetId: 't1',
    });
    const body = forwardLick.mock.calls[0]![0].body as Record<string, unknown>;
    expect(body.url).toBe('https://x/');
    expect('instruction' in body).toBe(false);
    expect('branch' in body).toBe(false);
    expect('path' in body).toBe(false);
    expect('title' in body).toBe(false);
  });

  it('drops the event cleanly when no sync is connected', async () => {
    const { startFollowerNavigateWatcher } = await import(
      '../../src/ui/follower-navigate-watcher.js'
    );
    expect(() => {
      startFollowerNavigateWatcher({} as never, () => null);
      captured!({
        url: 'https://x/',
        verb: 'handoff',
        target: 'https://x/',
        links: [],
        targetId: 't1',
      });
    }).not.toThrow();
  });

  it('forwards a discovery lick with the ARD fields intact to the current sync', async () => {
    const { startFollowerNavigateWatcher } = await import(
      '../../src/ui/follower-navigate-watcher.js'
    );
    const forwardLick = vi.fn((_event: LickEvent) => true);
    startFollowerNavigateWatcher({} as never, () => ({ forwardLick }));
    capturedDiscovery!({
      origin: 'https://shop.example',
      kind: 'ai-catalog',
      url: 'https://shop.example/.well-known/ai-catalog.json',
      targetId: 't1',
    });
    expect(forwardLick).toHaveBeenCalledTimes(1);
    const lick = forwardLick.mock.calls[0]![0];
    expect(lick.type).toBe('discovery');
    // Discovery-specific fields survive so the leader can dedup + render them.
    expect(lick.discoveryOrigin).toBe('https://shop.example');
    expect(lick.discoveryKind).toBe('ai-catalog');
    expect(lick.discoveryUrl).toBe('https://shop.example/.well-known/ai-catalog.json');
    // Follower never stamps origin — the leader is the origin authority.
    expect('originFollowerId' in lick).toBe(false);
    expect('originLabel' in lick).toBe(false);
    const body = lick.body as Record<string, unknown>;
    expect(body.origin).toBe('https://shop.example');
    expect(body.kind).toBe('ai-catalog');
    expect(body.url).toBe('https://shop.example/.well-known/ai-catalog.json');
    expect(body.targetId).toBe('t1');
  });

  it('forwards a well-known llms-txt discovery lick', async () => {
    const { startFollowerNavigateWatcher } = await import(
      '../../src/ui/follower-navigate-watcher.js'
    );
    const forwardLick = vi.fn((_event: LickEvent) => true);
    startFollowerNavigateWatcher({} as never, () => ({ forwardLick }));
    capturedDiscovery!({
      origin: 'https://docs.example',
      kind: 'llms-txt',
      url: 'https://docs.example/llms.txt',
      targetId: 't2',
    });
    const lick = forwardLick.mock.calls[0]![0];
    expect(lick.type).toBe('discovery');
    expect(lick.discoveryKind).toBe('llms-txt');
    expect(lick.discoveryUrl).toBe('https://docs.example/llms.txt');
  });

  it('drops a discovery event cleanly when no sync is connected', async () => {
    const { startFollowerNavigateWatcher } = await import(
      '../../src/ui/follower-navigate-watcher.js'
    );
    const forwardLick = vi.fn((_event: LickEvent) => true);
    expect(() => {
      startFollowerNavigateWatcher({} as never, () => null);
      capturedDiscovery!({
        origin: 'https://shop.example',
        kind: 'ai-catalog',
        url: 'https://shop.example/.well-known/ai-catalog.json',
        targetId: 't1',
      });
    }).not.toThrow();
    expect(forwardLick).not.toHaveBeenCalled();
  });

  it('wires the persisted setting so discovery is gated OFF (no probe, no emit)', async () => {
    // Mirror of the CLI navigation-watcher "does nothing when discovery is
    // disabled" test: the follower must forward the SAME slicc_discovery_enabled
    // setting to the NavigationWatcher, which gates BOTH the header vector and
    // the well-known probe. Setting OFF => isDiscoveryEnabled() returns false.
    const storage = makeMemoryStorage();
    storage.setItem('slicc_discovery_enabled', 'false');
    vi.stubGlobal('localStorage', storage);
    const { startFollowerNavigateWatcher } = await import(
      '../../src/ui/follower-navigate-watcher.js'
    );
    const forwardLick = vi.fn((_event: LickEvent) => true);
    startFollowerNavigateWatcher({} as never, () => ({ forwardLick }));
    expect(capturedIsEnabled).not.toBeNull();
    expect(capturedIsEnabled!()).toBe(false);
  });

  it('defaults the setting to ON so discovery stays live (opt-out)', async () => {
    vi.stubGlobal('localStorage', makeMemoryStorage());
    const { startFollowerNavigateWatcher } = await import(
      '../../src/ui/follower-navigate-watcher.js'
    );
    const forwardLick = vi.fn((_event: LickEvent) => true);
    startFollowerNavigateWatcher({} as never, () => ({ forwardLick }));
    expect(capturedIsEnabled).not.toBeNull();
    expect(capturedIsEnabled!()).toBe(true);
  });
});
