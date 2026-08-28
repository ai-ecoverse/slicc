import type { FollowerJoinRequestedMessage } from '@slicc/shared-ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LeaderTrayPeerManager,
  type TrayPeerConnectionLike,
} from '../../../src/scoops/tray-webrtc.js';

/** Structural stand-in; cast at the factory rather than `implements`, so the
 *  fake carries only what these tests exercise. */
class FakeChannel {
  readyState = 'connecting';
  private readonly listeners = new Map<string, Array<() => void>>();
  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send(): void {}
  close(): void {
    this.readyState = 'closed';
  }
  open(): void {
    this.readyState = 'open';
    for (const l of this.listeners.get('open') ?? []) l();
  }
}

class FakePeer {
  connectionState = 'new';
  closed = false;
  readonly channel = new FakeChannel();
  addEventListener(): void {}
  createDataChannel(): FakeChannel {
    return this.channel;
  }
  async createOffer() {
    return { type: 'offer' as const, sdp: 'x' };
  }
  async setLocalDescription(): Promise<void> {}
  async setRemoteDescription(): Promise<void> {}
  async addIceCandidate(): Promise<void> {}
  close(): void {
    this.closed = true;
  }
  get localDescription() {
    return { type: 'offer' as const, sdp: 'x' };
  }
}

const GATES = {
  message: { approver: 'user' as const },
  tool: { approver: 'user' as const },
};

function joinMessage(overrides: Partial<FollowerJoinRequestedMessage> = {}) {
  return {
    type: 'follower.join_requested',
    trayId: 'tray-1',
    controllerId: 'ctl-1',
    bootstrapId: 'boot-1',
    attempt: 1,
    expiresAt: '2026-08-27T13:00:00.000Z',
    trust: 'biscotto',
    biscotto: { id: 'seat1', label: 'Anna', gates: GATES },
    ...overrides,
  } as FollowerJoinRequestedMessage;
}

async function connectPeer(
  manager: LeaderTrayPeerManager,
  peer: FakePeer,
  message: FollowerJoinRequestedMessage
) {
  await manager.handleControlMessage(message);
  peer.channel.open();
}

describe('biscotto eviction', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('closes a live guest peer when its seat is revoked', async () => {
    const peer = new FakePeer();
    const closed: string[] = [];
    const manager = new LeaderTrayPeerManager({
      peerConnectionFactory: () => peer as unknown as TrayPeerConnectionLike,
      sendControlMessage: vi.fn(),
      onPeerTransportClosed: (bootstrapId) => closed.push(bootstrapId),
    });
    await connectPeer(manager, peer, joinMessage());
    expect(manager.getPeers()).toHaveLength(1);

    await manager.handleControlMessage({
      type: 'biscotto.revoked',
      trayId: 'tray-1',
      biscottoId: 'seat1',
    });

    // Revocation that only tombstones the token would leave this peer live:
    // the data channel is direct leader<->guest and the hub cannot reach it.
    expect(peer.closed).toBe(true);
    expect(closed).toEqual(['boot-1']);
    expect(manager.getPeers()).toHaveLength(0);
  });

  it('leaves other seats and full followers alone', async () => {
    const guest = new FakePeer();
    const owner = new FakePeer();
    let next: FakePeer = guest;
    const manager = new LeaderTrayPeerManager({
      peerConnectionFactory: () => next as unknown as TrayPeerConnectionLike,
      sendControlMessage: vi.fn(),
    });
    await connectPeer(manager, guest, joinMessage());
    next = owner;
    await connectPeer(
      manager,
      owner,
      joinMessage({
        controllerId: 'ctl-2',
        bootstrapId: 'boot-2',
        trust: 'full',
        biscotto: undefined,
      })
    );

    await manager.handleControlMessage({
      type: 'biscotto.revoked',
      trayId: 'tray-1',
      biscottoId: 'someone-else',
    });

    expect(guest.closed).toBe(false);
    expect(owner.closed).toBe(false);
    expect(manager.getPeers()).toHaveLength(2);
  });

  it('drops a guest when its seat expires', async () => {
    vi.setSystemTime(new Date('2026-08-27T12:00:00.000Z'));
    const peer = new FakePeer();
    const manager = new LeaderTrayPeerManager({
      peerConnectionFactory: () => peer as unknown as TrayPeerConnectionLike,
      sendControlMessage: vi.fn(),
    });
    await connectPeer(
      manager,
      peer,
      joinMessage({
        biscotto: {
          id: 'seat1',
          label: 'Anna',
          gates: GATES,
          expiresAt: '2026-08-27T12:10:00.000Z',
        },
      })
    );
    expect(manager.getPeers()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);

    expect(peer.closed).toBe(true);
    expect(manager.getPeers()).toHaveLength(0);
  });

  it('does not drop a seat whose expiry is beyond the setTimeout ceiling', async () => {
    vi.setSystemTime(new Date('2026-08-27T12:00:00.000Z'));
    const peer = new FakePeer();
    const manager = new LeaderTrayPeerManager({
      peerConnectionFactory: () => peer as unknown as TrayPeerConnectionLike,
      sendControlMessage: vi.fn(),
    });
    // 30 days is past 2^31-1 ms; an unclamped setTimeout fires immediately and
    // would evict a seat that is still perfectly valid.
    await connectPeer(
      manager,
      peer,
      joinMessage({
        biscotto: {
          id: 'seat1',
          label: 'Anna',
          gates: GATES,
          expiresAt: '2026-09-26T12:00:00.000Z',
        },
      })
    );

    await vi.advanceTimersByTimeAsync(2_147_483_647 + 10);

    expect(peer.closed).toBe(false);
    expect(manager.getPeers()).toHaveLength(1);
  });

  it('never arms an expiry for a full-trust follower', async () => {
    vi.setSystemTime(new Date('2026-08-27T12:00:00.000Z'));
    const peer = new FakePeer();
    const manager = new LeaderTrayPeerManager({
      peerConnectionFactory: () => peer as unknown as TrayPeerConnectionLike,
      sendControlMessage: vi.fn(),
    });
    await connectPeer(manager, peer, joinMessage({ trust: 'full', biscotto: undefined }));
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(peer.closed).toBe(false);
  });
});
