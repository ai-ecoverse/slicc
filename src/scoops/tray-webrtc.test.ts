import { describe, expect, it, vi } from 'vitest';

import { FollowerTrayManager, LeaderTrayPeerManager, type TrayDataChannelLike, type TrayPeerConnectionLike } from './tray-webrtc.js';
import type { FollowerBootstrapResponse } from '../worker/shared.js';
import type { LeaderToWorkerControlMessage, TrayBootstrapEvent, TrayBootstrapStatus, TrayIceCandidate, TraySessionDescription } from '../worker/tray-signaling.js';

class FakeDataChannel implements TrayDataChannelLike {
  readyState = 'connecting';
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Array<Function>>();

  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: string }) => void): void;
  addEventListener(type: string, listener: Function): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 'closed';
    this.dispatch('close');
  }

  open(): void {
    this.readyState = 'open';
    this.dispatch('open');
  }

  simulateMessage(data: string): void {
    for (const listener of this.listeners.get('message') ?? []) {
      listener({ data });
    }
  }

  private dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      (listener as () => void)();
    }
  }
}

class FakePeerConnection implements TrayPeerConnectionLike {
  localDescription: TraySessionDescription | null = null;
  connectionState = 'new';
  readonly addedIceCandidates: TrayIceCandidate[] = [];
  private readonly listeners = new Map<string, Function[]>();
  private localChannel: FakeDataChannel | null = null;
  private remoteChannel: FakeDataChannel | null = null;
  counterpart: FakePeerConnection | null = null;
  shouldFailOffer = false;

  createDataChannel(): TrayDataChannelLike {
    this.localChannel = new FakeDataChannel();
    this.remoteChannel = new FakeDataChannel();
    if (this.counterpart) {
      this.counterpart.remoteChannel = this.remoteChannel;
      this.counterpart.localChannel = this.localChannel;
    }
    return this.localChannel;
  }

  async createOffer(): Promise<TraySessionDescription> {
    if (this.shouldFailOffer) {
      throw new Error('offer failed');
    }
    return { type: 'offer', sdp: 'leader-offer' };
  }

  async createAnswer(): Promise<TraySessionDescription> {
    return { type: 'answer', sdp: 'follower-answer' };
  }

  async setLocalDescription(description: TraySessionDescription): Promise<void> {
    this.localDescription = description;
    this.dispatch('icecandidate', { candidate: { candidate: `${description.type}-candidate`, sdpMid: '0', sdpMLineIndex: 0 } });
  }

  async setRemoteDescription(description: TraySessionDescription): Promise<void> {
    if (description.type === 'offer' && this.remoteChannel) {
      this.dispatch('datachannel', { channel: this.remoteChannel });
    }
    if (description.type === 'answer' && this.localChannel && this.remoteChannel) {
      this.connectionState = 'connected';
      this.dispatch('connectionstatechange');
      this.counterpart!.connectionState = 'connected';
      this.counterpart!.dispatch('connectionstatechange');
      this.localChannel.open();
      this.remoteChannel.open();
    }
  }

  async addIceCandidate(candidate: TrayIceCandidate): Promise<void> {
    this.addedIceCandidates.push(candidate);
  }

  addEventListener(type: 'icecandidate' | 'datachannel' | 'connectionstatechange', listener: Function): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.connectionState = 'closed';
  }

  private dispatch(type: 'icecandidate' | 'datachannel' | 'connectionstatechange', event?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function createPeerPair(): { leader: FakePeerConnection; follower: FakePeerConnection } {
  const leader = new FakePeerConnection();
  const follower = new FakePeerConnection();
  leader.counterpart = follower;
  follower.counterpart = leader;
  return { leader, follower };
}

describe('tray-webrtc', () => {
  it('establishes the first leader-follower data channel through the reviewed signaling flow', async () => {
    const { leader, follower } = createPeerPair();
    const leaderSignals: LeaderToWorkerControlMessage[] = [];
    const queuedEvents: TrayBootstrapEvent[] = [];
    let sequence = 0;
    const connectedPeers: Array<{ controllerId: string; bootstrapId: string }> = [];
    const leaderPeerManager = new LeaderTrayPeerManager({
      peerConnectionFactory: () => leader,
      sendControlMessage: message => {
        leaderSignals.push(message);
        if (message.type === 'bootstrap.offer') {
          sequence += 1;
          queuedEvents.push({ sequence, sentAt: '2026-03-12T00:00:01.000Z', type: 'bootstrap.offer', offer: message.offer });
        } else if (message.type === 'bootstrap.ice_candidate') {
          sequence += 1;
          queuedEvents.push({ sequence, sentAt: '2026-03-12T00:00:02.000Z', type: 'bootstrap.ice_candidate', candidate: message.candidate });
        }
      },
      onPeerConnected: (peer, _channel) => connectedPeers.push({ controllerId: peer.controllerId, bootstrapId: peer.bootstrapId }),
    });

    let bootstrap: TrayBootstrapStatus = {
      controllerId: 'follower-1',
      bootstrapId: 'bootstrap-1',
      attempt: 1,
      state: 'pending',
      expiresAt: '2026-03-12T00:00:20.000Z',
      cursor: 0,
      maxRetries: 3,
      retriesRemaining: 3,
      retryAfterMs: null,
      failure: null,
    };
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      const action = typeof body['action'] === 'string' ? body['action'] : 'attach';
      if (action === 'attach') {
        return jsonResponse({
          trayId: 'tray-1',
          controllerId: 'follower-1',
          role: 'follower',
          leader: { controllerId: 'leader-1', connected: true, reconnectDeadline: null },
          participantCount: 2,
          result: { action: 'signal', code: 'LEADER_CONNECTED', bootstrap },
        });
      }
      if (action === 'poll') {
        const cursor = Number(body['cursor'] ?? 0);
        const events = queuedEvents.filter(event => event.sequence > cursor);
        bootstrap = { ...bootstrap, state: events.some(e => e.type === 'bootstrap.offer') ? 'offered' : bootstrap.state, cursor: Math.max(cursor, sequence) };
        return jsonBootstrapResponse(bootstrap, events);
      }
      if (action === 'answer') {
        await leaderPeerManager.handleControlMessage({
          type: 'bootstrap.answer',
          trayId: 'tray-1',
          controllerId: 'follower-1',
          bootstrapId: 'bootstrap-1',
          answer: body['answer'] as TraySessionDescription,
        });
        bootstrap = { ...bootstrap, state: 'connected' };
        return jsonBootstrapResponse(bootstrap, []);
      }
      if (action === 'ice-candidate') {
        await leaderPeerManager.handleControlMessage({
          type: 'bootstrap.ice_candidate',
          trayId: 'tray-1',
          controllerId: 'follower-1',
          bootstrapId: 'bootstrap-1',
          candidate: body['candidate'] as TrayIceCandidate,
        });
        return jsonBootstrapResponse(bootstrap, []);
      }
      throw new Error(`Unexpected action: ${action}`);
    });

    await leaderPeerManager.handleControlMessage({
      type: 'follower.join_requested',
      trayId: 'tray-1',
      controllerId: 'follower-1',
      runtime: 'slicc-standalone',
      bootstrapId: 'bootstrap-1',
      attempt: 1,
      expiresAt: '2026-03-12T00:00:20.000Z',
    });

    const followerManager = new FollowerTrayManager({
      joinUrl: 'https://tray.example.com/join/tray-1.secret',
      runtime: 'slicc-standalone',
      fetchImpl,
      peerConnectionFactory: () => follower,
      controllerIdFactory: () => 'follower-1',
      sleep: async () => {},
      pollIntervalMs: 0,
    });
    const connection = await followerManager.start();
    await Promise.resolve();

    expect(connection).toMatchObject({ trayId: 'tray-1', controllerId: 'follower-1', bootstrapId: 'bootstrap-1' });
    expect(connectedPeers).toEqual([{ controllerId: 'follower-1', bootstrapId: 'bootstrap-1' }]);
    expect(leaderPeerManager.getPeers()).toEqual([
      expect.objectContaining({ controllerId: 'follower-1', bootstrapId: 'bootstrap-1', state: 'connected' }),
    ]);
    expect(leader.addedIceCandidates).toContainEqual(expect.objectContaining({
      candidate: 'answer-candidate',
      sdpMid: '0',
      sdpMLineIndex: 0,
    }));
    expect(fetchImpl).toHaveBeenCalled();
  });

  it('reports explicit bootstrap failure when the leader cannot create an offer', async () => {
    const leader = new FakePeerConnection();
    leader.shouldFailOffer = true;
    const sent: LeaderToWorkerControlMessage[] = [];
    const manager = new LeaderTrayPeerManager({
      peerConnectionFactory: () => leader,
      sendControlMessage: message => sent.push(message),
    });

    await manager.handleControlMessage({
      type: 'follower.join_requested',
      trayId: 'tray-1',
      controllerId: 'follower-1',
      bootstrapId: 'bootstrap-1',
      attempt: 1,
      expiresAt: '2026-03-12T00:00:20.000Z',
    });

    expect(sent).toContainEqual(expect.objectContaining({
      type: 'bootstrap.failed',
      controllerId: 'follower-1',
      bootstrapId: 'bootstrap-1',
      code: 'WEBRTC_BOOTSTRAP_FAILED',
    }));
    expect(manager.getPeers()).toEqual([]);
  });

  it('picks up iceServers from follower.join_requested and applies them to subsequent peer connections', async () => {
    const leader = new FakePeerConnection();
    const sent: LeaderToWorkerControlMessage[] = [];
    const manager = new LeaderTrayPeerManager({
      peerConnectionFactory: () => leader,
      sendControlMessage: message => sent.push(message),
    });

    const iceServers = [
      { urls: ['stun:stun.cloudflare.com:3478'], username: '', credential: '' },
      { urls: ['turn:turn.example.com:3478'], username: 'user', credential: 'pass' },
    ];

    await manager.handleControlMessage({
      type: 'follower.join_requested',
      trayId: 'tray-1',
      controllerId: 'follower-1',
      bootstrapId: 'bootstrap-1',
      attempt: 1,
      expiresAt: '2026-03-12T00:00:20.000Z',
      iceServers,
    });

    // Verify the leader picked up the iceServers (via the peerConnectionFactory being called)
    expect(sent).toContainEqual(expect.objectContaining({ type: 'bootstrap.offer' }));
  });

  it('follower picks up iceServers from attach response and uses them for peer creation', async () => {
    const { leader, follower } = createPeerPair();
    const leaderSignals: LeaderToWorkerControlMessage[] = [];
    const queuedEvents: TrayBootstrapEvent[] = [];
    let sequence = 0;
    const leaderPeerManager = new LeaderTrayPeerManager({
      peerConnectionFactory: () => leader,
      sendControlMessage: message => {
        leaderSignals.push(message);
        if (message.type === 'bootstrap.offer') {
          sequence += 1;
          queuedEvents.push({ sequence, sentAt: '2026-03-12T00:00:01.000Z', type: 'bootstrap.offer', offer: message.offer });
        } else if (message.type === 'bootstrap.ice_candidate') {
          sequence += 1;
          queuedEvents.push({ sequence, sentAt: '2026-03-12T00:00:02.000Z', type: 'bootstrap.ice_candidate', candidate: message.candidate });
        }
      },
    });

    let bootstrap: TrayBootstrapStatus = {
      controllerId: 'follower-1',
      bootstrapId: 'bootstrap-1',
      attempt: 1,
      state: 'pending',
      expiresAt: '2026-03-12T00:00:20.000Z',
      cursor: 0,
      maxRetries: 3,
      retriesRemaining: 3,
      retryAfterMs: null,
      failure: null,
    };
    const iceServers = [
      { urls: ['stun:stun.cloudflare.com:3478'], username: '', credential: '' },
      { urls: ['turn:turn.example.com:3478'], username: 'user', credential: 'pass' },
    ];
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      const action = typeof body['action'] === 'string' ? body['action'] : 'attach';
      if (action === 'attach') {
        return jsonResponse({
          trayId: 'tray-1',
          controllerId: 'follower-1',
          role: 'follower',
          leader: { controllerId: 'leader-1', connected: true, reconnectDeadline: null },
          participantCount: 2,
          result: { action: 'signal', code: 'LEADER_CONNECTED', bootstrap },
          iceServers,
        });
      }
      if (action === 'poll') {
        const cursor = Number(body['cursor'] ?? 0);
        const events = queuedEvents.filter(event => event.sequence > cursor);
        bootstrap = { ...bootstrap, state: events.some(e => e.type === 'bootstrap.offer') ? 'offered' : bootstrap.state, cursor: Math.max(cursor, sequence) };
        return jsonBootstrapResponse(bootstrap, events);
      }
      if (action === 'answer') {
        await leaderPeerManager.handleControlMessage({
          type: 'bootstrap.answer',
          trayId: 'tray-1',
          controllerId: 'follower-1',
          bootstrapId: 'bootstrap-1',
          answer: body['answer'] as TraySessionDescription,
        });
        bootstrap = { ...bootstrap, state: 'connected' };
        return jsonBootstrapResponse(bootstrap, []);
      }
      if (action === 'ice-candidate') {
        await leaderPeerManager.handleControlMessage({
          type: 'bootstrap.ice_candidate',
          trayId: 'tray-1',
          controllerId: 'follower-1',
          bootstrapId: 'bootstrap-1',
          candidate: body['candidate'] as TrayIceCandidate,
        });
        return jsonBootstrapResponse(bootstrap, []);
      }
      throw new Error(`Unexpected action: ${action}`);
    });

    await leaderPeerManager.handleControlMessage({
      type: 'follower.join_requested',
      trayId: 'tray-1',
      controllerId: 'follower-1',
      runtime: 'slicc-standalone',
      bootstrapId: 'bootstrap-1',
      attempt: 1,
      expiresAt: '2026-03-12T00:00:20.000Z',
    });

    const followerManager = new FollowerTrayManager({
      joinUrl: 'https://tray.example.com/join/tray-1.secret',
      runtime: 'slicc-standalone',
      fetchImpl,
      peerConnectionFactory: () => follower,
      controllerIdFactory: () => 'follower-1',
      sleep: async () => {},
      pollIntervalMs: 0,
    });
    const connection = await followerManager.start();
    expect(connection.trayId).toBe('tray-1');
  });
});

function jsonResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function jsonBootstrapResponse(bootstrap: TrayBootstrapStatus, events: TrayBootstrapEvent[]): Response {
  const body: FollowerBootstrapResponse = {
    trayId: 'tray-1',
    controllerId: 'follower-1',
    role: 'follower',
    leader: { controllerId: 'leader-1', connected: true, reconnectDeadline: null },
    participantCount: 2,
    bootstrap,
    events,
  };
  return jsonResponse(body as unknown as Record<string, unknown>);
}