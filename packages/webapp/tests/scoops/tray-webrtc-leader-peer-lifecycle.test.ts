/**
 * Leader-side peer lifecycle (#3477): every follower bootstrap gets its own
 * `RTCPeerConnection`, and the browser caps how many a page may hold (Chrome:
 * 500). A long-running hosted leader serves a fresh peer per `slicc exec`, so a
 * peer that outlives its follower eventually makes the leader refuse all new
 * followers while existing channels keep working.
 */
import type {
  FollowerJoinRequestedMessage,
  LeaderToWorkerControlMessage,
  TraySessionDescription,
} from '@slicc/shared-ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LeaderTrayPeerManager,
  type TrayDataChannelLike,
  type TrayPeerConnectionLike,
} from '../../src/scoops/tray-webrtc.js';

// The fakes only dispatch argument-less events; `never[]` accepts every typed listener overload.
type AnyListener = (...args: never[]) => void;

const CHROME_PEER_CAP_ERROR =
  "Failed to construct 'RTCPeerConnection': Cannot create so many PeerConnections";

class FakeChannel implements TrayDataChannelLike {
  readyState = 'connecting';
  private readonly listeners = new Map<string, Array<AnyListener>>();

  addEventListener(type: string, listener: AnyListener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(): void {}

  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.dispatch('close');
  }

  open(): void {
    this.readyState = 'open';
    this.dispatch('open');
  }

  private dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

class FakePeer implements TrayPeerConnectionLike {
  connectionState = 'new';
  localDescription: TraySessionDescription | null = null;
  closed = false;
  readonly channel = new FakeChannel();
  private readonly listeners = new Map<string, Array<AnyListener>>();

  constructor(private readonly onClosed: () => void) {}

  createDataChannel(): TrayDataChannelLike {
    return this.channel;
  }

  async createOffer(): Promise<TraySessionDescription> {
    return { type: 'offer', sdp: 'offer' };
  }

  async createAnswer(): Promise<TraySessionDescription> {
    return { type: 'answer', sdp: 'answer' };
  }

  async setLocalDescription(description: TraySessionDescription): Promise<void> {
    this.localDescription = description;
  }

  async setRemoteDescription(): Promise<void> {}

  async addIceCandidate(): Promise<void> {}

  addEventListener(type: string, listener: AnyListener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  setConnectionState(state: string): void {
    this.connectionState = state;
    for (const listener of this.listeners.get('connectionstatechange') ?? []) listener();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.connectionState = 'closed';
    this.onClosed();
  }
}

/** Models the browser's per-page peer-connection cap: only close() frees a slot. */
class CappedPeerFactory {
  live = 0;
  readonly created: FakePeer[] = [];

  constructor(private readonly cap: number) {}

  readonly create = (): FakePeer => {
    if (this.live >= this.cap) throw new Error(CHROME_PEER_CAP_ERROR);
    this.live += 1;
    const peer = new FakePeer(() => {
      this.live -= 1;
    });
    this.created.push(peer);
    return peer;
  };
}

let sequence = 0;
function joinRequest(overrides: Partial<FollowerJoinRequestedMessage> = {}) {
  sequence += 1;
  return {
    type: 'follower.join_requested' as const,
    trayId: 'tray-1',
    // A fresh controller id per request, exactly like `slicc exec`.
    controllerId: `cli-${sequence}`,
    bootstrapId: `bootstrap-${sequence}`,
    attempt: 1,
    expiresAt: new Date(Date.now() + 20_000).toISOString(),
    ...overrides,
  };
}

function createManager(factory: CappedPeerFactory) {
  const sent: LeaderToWorkerControlMessage[] = [];
  const onPeerTransportClosed = vi.fn();
  const onPeerDisconnected = vi.fn();
  const manager = new LeaderTrayPeerManager({
    peerConnectionFactory: factory.create,
    sendControlMessage: (message) => sent.push(message),
    onPeerTransportClosed,
    onPeerDisconnected,
  });
  return { manager, sent, onPeerTransportClosed, onPeerDisconnected };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('LeaderTrayPeerManager peer lifecycle (#3477)', () => {
  it('keeps answering new followers after more short-lived followers than the browser cap', async () => {
    const factory = new CappedPeerFactory(5);
    const { manager, sent } = createManager(factory);

    for (let i = 0; i < 20; i++) {
      const request = joinRequest();
      await manager.handleControlMessage(request);
      const peer = factory.created.at(-1)!;
      peer.channel.open();
      // The CLI runs its command and exits: the follower's channel closes.
      peer.channel.close();
      expect(sent).toContainEqual(
        expect.objectContaining({ type: 'bootstrap.offer', bootstrapId: request.bootstrapId })
      );
    }

    expect(sent.filter((message) => message.type === 'bootstrap.failed')).toEqual([]);
    expect(factory.live).toBe(0);
    expect(manager.getPeers()).toEqual([]);
  });

  it('closes a connected peer once its data channel closes and tells the sync layer', async () => {
    const factory = new CappedPeerFactory(10);
    const { manager, onPeerTransportClosed, onPeerDisconnected } = createManager(factory);
    const request = joinRequest();

    await manager.handleControlMessage(request);
    const peer = factory.created[0]!;
    peer.channel.open();
    expect(manager.getPeers()).toEqual([expect.objectContaining({ state: 'connected' })]);

    peer.channel.close();

    expect(peer.closed).toBe(true);
    expect(manager.getPeers()).toEqual([]);
    expect(onPeerDisconnected).toHaveBeenCalledWith(request.bootstrapId, 'Data channel closed');
    expect(onPeerTransportClosed).toHaveBeenCalledTimes(1);
    expect(onPeerTransportClosed).toHaveBeenCalledWith(request.bootstrapId, 'Data channel closed');
  });

  it('closes a connected peer whose connection fails, but keeps one that is only disconnected', async () => {
    const factory = new CappedPeerFactory(10);
    const { manager, onPeerTransportClosed } = createManager(factory);
    const request = joinRequest();

    await manager.handleControlMessage(request);
    const peer = factory.created[0]!;
    peer.channel.open();

    peer.setConnectionState('disconnected');
    expect(peer.closed).toBe(false);
    expect(manager.getPeers()).toHaveLength(1);

    peer.setConnectionState('failed');
    expect(peer.closed).toBe(true);
    expect(manager.getPeers()).toEqual([]);
    expect(onPeerTransportClosed).toHaveBeenCalledWith(
      request.bootstrapId,
      'Peer connection failed'
    );
  });

  it('closes a peer whose follower never answered once the bootstrap has expired', async () => {
    vi.useFakeTimers();
    const factory = new CappedPeerFactory(10);
    const { manager, sent } = createManager(factory);
    const request = joinRequest({ expiresAt: new Date(Date.now() + 20_000).toISOString() });

    await manager.handleControlMessage(request);
    const peer = factory.created[0]!;

    await vi.advanceTimersByTimeAsync(20_000);
    expect(peer.closed).toBe(false);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(peer.closed).toBe(true);
    expect(factory.live).toBe(0);
    expect(manager.getPeers()).toEqual([]);
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: 'bootstrap.failed',
        bootstrapId: request.bootstrapId,
        message: 'Follower did not connect before the bootstrap expired',
      })
    );
  });

  it('does not close a peer that connected before its bootstrap deadline', async () => {
    vi.useFakeTimers();
    const factory = new CappedPeerFactory(10);
    const { manager } = createManager(factory);

    await manager.handleControlMessage(joinRequest());
    const peer = factory.created[0]!;
    peer.channel.open();

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(peer.closed).toBe(false);
    expect(manager.getPeers()).toEqual([expect.objectContaining({ state: 'connected' })]);
  });

  it('fails the bootstrap explicitly when the browser refuses a new peer connection', async () => {
    const factory = new CappedPeerFactory(0);
    const { manager, sent } = createManager(factory);
    const request = joinRequest();

    await expect(manager.handleControlMessage(request)).resolves.toBeUndefined();

    expect(sent).toEqual([
      expect.objectContaining({
        type: 'bootstrap.failed',
        controllerId: request.controllerId,
        bootstrapId: request.bootstrapId,
        code: 'WEBRTC_BOOTSTRAP_FAILED',
        message: expect.stringContaining('Cannot create so many PeerConnections'),
      }),
    ]);
    expect(manager.getPeers()).toEqual([]);
  });

  it('closes the peer when its data channel cannot be created', async () => {
    const factory = new CappedPeerFactory(10);
    const created: FakePeer[] = [];
    const sent: LeaderToWorkerControlMessage[] = [];
    const manager = new LeaderTrayPeerManager({
      peerConnectionFactory: () => {
        const peer = factory.create();
        peer.createDataChannel = () => {
          throw new Error('data channel refused');
        };
        created.push(peer);
        return peer;
      },
      sendControlMessage: (message) => sent.push(message),
    });

    await manager.handleControlMessage(joinRequest());

    expect(created[0]!.closed).toBe(true);
    expect(factory.live).toBe(0);
    expect(sent).toEqual([
      expect.objectContaining({
        type: 'bootstrap.failed',
        message: expect.stringContaining('data channel refused'),
      }),
    ]);
  });

  it('releases the superseded peer when the same controller retries its bootstrap', async () => {
    const factory = new CappedPeerFactory(10);
    const { manager, onPeerTransportClosed } = createManager(factory);
    const first = joinRequest({ controllerId: 'browser-follower' });

    await manager.handleControlMessage(first);
    factory.created[0]!.channel.open();
    await manager.handleControlMessage(joinRequest({ controllerId: 'browser-follower' }));

    expect(factory.created[0]!.closed).toBe(true);
    expect(factory.live).toBe(1);
    expect(onPeerTransportClosed).toHaveBeenCalledWith(first.bootstrapId, 'Controller superseded');
    expect(manager.getPeers()).toHaveLength(1);
  });

  it('stop() closes every peer and cancels pending connect deadlines', async () => {
    vi.useFakeTimers();
    const factory = new CappedPeerFactory(10);
    const { manager, sent } = createManager(factory);

    await manager.handleControlMessage(joinRequest());
    await manager.handleControlMessage(joinRequest());
    manager.stop();

    expect(factory.live).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(sent.filter((message) => message.type === 'bootstrap.failed')).toEqual([]);
  });
});
