/**
 * Cross-tab OPFS leader election.
 *
 * Pins:
 *  - Lone tab → becomes leader after the timeout elapses.
 *  - Joining tab → existing leader acks it; newcomer becomes a
 *    follower without waiting for the full timeout.
 *  - Simultaneous boot → older `(claimedAt, tabId)` wins
 *    deterministically; loser becomes follower.
 *  - Leader keeps acking subsequent claimants until disposed.
 *  - Follower path tears down the channel on resolution; calling
 *    `dispose()` is idempotent. Leader path keeps the channel open
 *    until `dispose()`.
 *  - Stale `ack` targeted at a different tab is ignored.
 *  - Missing/unsupported `BroadcastChannel` falls back to leader.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { electOpfsLeader, type OpfsLeaderChannelLike } from '../../src/ui/opfs-leader-election.js';

/**
 * In-memory BroadcastChannel shim. Async delivery via `queueMicrotask`,
 * never delivers to the posting instance. Mirrors the shape used in
 * tests/cdp/standalone-remote-cdp-bridge.integration.test.ts.
 */
class FakeChannel implements OpfsLeaderChannelLike {
  private static buses = new Map<string, Set<FakeChannel>>();
  private listeners = new Set<(ev: MessageEvent) => void>();
  private closed = false;

  constructor(public readonly name: string) {
    let bus = FakeChannel.buses.get(name);
    if (!bus) {
      bus = new Set();
      FakeChannel.buses.set(name, bus);
    }
    bus.add(this);
  }

  postMessage(data: unknown): void {
    if (this.closed) return;
    const bus = FakeChannel.buses.get(this.name);
    if (!bus) return;
    const cloned = structuredClone(data);
    for (const peer of bus) {
      if (peer === this || peer.closed) continue;
      queueMicrotask(() => {
        for (const l of peer.listeners) l(new MessageEvent('message', { data: cloned }));
      });
    }
  }

  addEventListener(_type: 'message', listener: (ev: MessageEvent) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'message', listener: (ev: MessageEvent) => void): void {
    this.listeners.delete(listener);
  }

  close(): void {
    this.closed = true;
    FakeChannel.buses.get(this.name)?.delete(this);
    this.listeners.clear();
  }

  static reset(): void {
    for (const bus of FakeChannel.buses.values()) {
      for (const ch of bus) ch.closed = true;
    }
    FakeChannel.buses.clear();
  }

  static peers(name: string): FakeChannel[] {
    return Array.from(FakeChannel.buses.get(name) ?? []);
  }
}

const CH = 'test-opfs-leader';
const factory = (name: string): OpfsLeaderChannelLike => new FakeChannel(name);
const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  FakeChannel.reset();
});
afterEach(() => {
  FakeChannel.reset();
});

describe('electOpfsLeader', () => {
  it('lone tab becomes leader after the election timeout', async () => {
    const result = await electOpfsLeader({
      channelName: CH,
      channelFactory: factory,
      electionTimeoutMs: 10,
      tabId: 'solo',
      claimedAt: 1_000,
    });
    expect(result.isLeader).toBe(true);
    expect(result.self).toEqual({ tabId: 'solo', claimedAt: 1_000 });
    expect(result.leader).toBeUndefined();
    result.dispose();
  });

  it('joining tab becomes follower when an existing leader acks', async () => {
    const leader = await electOpfsLeader({
      channelName: CH,
      channelFactory: factory,
      electionTimeoutMs: 10,
      tabId: 'leader',
      claimedAt: 1_000,
    });
    expect(leader.isLeader).toBe(true);

    // The leader is still on the bus and will ack a newcomer well
    // before the newcomer's own timeout fires.
    const follower = await electOpfsLeader({
      channelName: CH,
      channelFactory: factory,
      electionTimeoutMs: 5_000,
      tabId: 'newcomer',
      claimedAt: 2_000,
    });

    expect(follower.isLeader).toBe(false);
    expect(follower.leader).toEqual({ tabId: 'leader', claimedAt: 1_000 });
    expect(follower.self).toEqual({ tabId: 'newcomer', claimedAt: 2_000 });

    follower.dispose();
    leader.dispose();
  });

  it('simultaneous boot resolves deterministically: older claimedAt wins', async () => {
    const [a, b] = await Promise.all([
      electOpfsLeader({
        channelName: CH,
        channelFactory: factory,
        electionTimeoutMs: 50,
        tabId: 'tab-a',
        claimedAt: 1_000,
      }),
      electOpfsLeader({
        channelName: CH,
        channelFactory: factory,
        electionTimeoutMs: 50,
        tabId: 'tab-b',
        claimedAt: 2_000,
      }),
    ]);

    expect(a.isLeader).toBe(true);
    expect(b.isLeader).toBe(false);
    expect(b.leader).toEqual({ tabId: 'tab-a', claimedAt: 1_000 });

    a.dispose();
    b.dispose();
  });

  it('simultaneous boot with identical claimedAt breaks tie on lower tabId', async () => {
    const [a, b] = await Promise.all([
      electOpfsLeader({
        channelName: CH,
        channelFactory: factory,
        electionTimeoutMs: 50,
        tabId: 'aaa',
        claimedAt: 1_000,
      }),
      electOpfsLeader({
        channelName: CH,
        channelFactory: factory,
        electionTimeoutMs: 50,
        tabId: 'zzz',
        claimedAt: 1_000,
      }),
    ]);
    expect(a.isLeader).toBe(true);
    expect(b.isLeader).toBe(false);
    expect(b.leader?.tabId).toBe('aaa');
    a.dispose();
    b.dispose();
  });

  it('leader keeps acking subsequent claimants until disposed', async () => {
    const leader = await electOpfsLeader({
      channelName: CH,
      channelFactory: factory,
      electionTimeoutMs: 10,
      tabId: 'leader',
      claimedAt: 1_000,
    });
    expect(leader.isLeader).toBe(true);

    const second = await electOpfsLeader({
      channelName: CH,
      channelFactory: factory,
      electionTimeoutMs: 5_000,
      tabId: 'second',
      claimedAt: 2_000,
    });
    expect(second.isLeader).toBe(false);

    const third = await electOpfsLeader({
      channelName: CH,
      channelFactory: factory,
      electionTimeoutMs: 5_000,
      tabId: 'third',
      claimedAt: 3_000,
    });
    expect(third.isLeader).toBe(false);
    expect(third.leader?.tabId).toBe('leader');

    leader.dispose();
    second.dispose();
    third.dispose();
  });

  it('follower path closes the channel on resolution; dispose is idempotent', async () => {
    const leader = await electOpfsLeader({
      channelName: CH,
      channelFactory: factory,
      electionTimeoutMs: 10,
      tabId: 'leader',
      claimedAt: 1_000,
    });
    const follower = await electOpfsLeader({
      channelName: CH,
      channelFactory: factory,
      electionTimeoutMs: 5_000,
      tabId: 'follower',
      claimedAt: 2_000,
    });
    expect(follower.isLeader).toBe(false);
    // Follower removed itself from the bus on resolution. Only the
    // leader's channel remains.
    expect(FakeChannel.peers(CH).length).toBe(1);
    follower.dispose();
    follower.dispose();
    leader.dispose();
    leader.dispose();
  });

  it('leader holds the channel open until disposed', async () => {
    const leader = await electOpfsLeader({
      channelName: CH,
      channelFactory: factory,
      electionTimeoutMs: 10,
      tabId: 'leader',
      claimedAt: 1_000,
    });
    expect(FakeChannel.peers(CH).length).toBe(1);
    leader.dispose();
    await tick();
    expect(FakeChannel.peers(CH).length).toBe(0);
  });

  it('ignores ack messages targeted at a different tab', async () => {
    const channel = new FakeChannel(CH);
    // Inject a stray ack BEFORE the elector boots.
    queueMicrotask(() => {
      channel.postMessage({
        type: 'opfs-leader:ack',
        tabId: 'ghost-leader',
        claimedAt: 0,
        targetTabId: 'not-us',
      });
    });
    const result = await electOpfsLeader({
      channelName: CH,
      channelFactory: factory,
      electionTimeoutMs: 30,
      tabId: 'us',
      claimedAt: 1_000,
    });
    // Stray ack ignored → timeout fires → we promote to leader.
    expect(result.isLeader).toBe(true);
    result.dispose();
    channel.close();
  });

  it('falls back to leader when BroadcastChannel construction throws', async () => {
    const result = await electOpfsLeader({
      channelName: CH,
      channelFactory: () => {
        throw new Error('no channel here');
      },
      electionTimeoutMs: 10,
      tabId: 'solo',
      claimedAt: 1_000,
      logger: { warn: vi.fn() },
    });
    expect(result.isLeader).toBe(true);
    result.dispose();
  });
});
