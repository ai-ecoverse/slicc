import { createLogger } from '../core/logger.js';
import type { LeaderToWorkerControlMessage, WorkerToLeaderControlMessage, FollowerJoinRequestedMessage } from '../worker/tray-signaling.js';
import type { TrayBootstrapStatus, TrayIceCandidate, TraySessionDescription } from '../worker/tray-signaling.js';
import {
  attachTrayFollower,
  pollTrayFollowerBootstrap,
  retryTrayFollowerBootstrap,
  sendTrayFollowerAnswer,
  sendTrayFollowerIceCandidate,
} from './tray-follower.js';
import { setFollowerTrayRuntimeStatus } from './tray-follower-status.js';

const log = createLogger('tray-webrtc');
const DEFAULT_DATA_CHANNEL_LABEL = 'tray-control';
const DEFAULT_POLL_INTERVAL_MS = 250;

export interface TrayDataChannelLike {
  readyState?: string;
  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void;
  close(): void;
}

export interface TrayPeerConnectionLike {
  localDescription?: TraySessionDescription | null;
  connectionState?: string;
  createDataChannel(label: string): TrayDataChannelLike;
  createOffer(): Promise<TraySessionDescription>;
  createAnswer(): Promise<TraySessionDescription>;
  setLocalDescription(description: TraySessionDescription): Promise<void>;
  setRemoteDescription(description: TraySessionDescription): Promise<void>;
  addIceCandidate(candidate: TrayIceCandidate): Promise<void>;
  addEventListener(type: 'icecandidate', listener: (event: { candidate: unknown }) => void): void;
  addEventListener(type: 'datachannel', listener: (event: { channel: TrayDataChannelLike }) => void): void;
  addEventListener(type: 'connectionstatechange', listener: () => void): void;
  close(): void;
}

export type TrayPeerConnectionFactory = () => TrayPeerConnectionLike;

export interface LeaderTrayPeerState {
  controllerId: string;
  bootstrapId: string;
  attempt: number;
  state: 'connecting' | 'connected';
  connectedAt: string | null;
}

export interface LeaderTrayPeerManagerOptions {
  sendControlMessage: (message: LeaderToWorkerControlMessage) => void;
  peerConnectionFactory?: TrayPeerConnectionFactory;
  dataChannelLabel?: string;
  onPeerConnected?: (peer: LeaderTrayPeerState) => void;
}

export interface FollowerTrayConnection {
  trayId: string;
  controllerId: string;
  bootstrapId: string;
  channel: TrayDataChannelLike;
}

export interface FollowerTrayManagerOptions {
  joinUrl: string;
  runtime: string;
  fetchImpl?: typeof fetch;
  peerConnectionFactory?: TrayPeerConnectionFactory;
  controllerIdFactory?: () => string;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
}

interface ActiveLeaderPeer {
  state: LeaderTrayPeerState;
  peer: TrayPeerConnectionLike;
}

interface ActiveFollowerPeer {
  peer: TrayPeerConnectionLike;
  channel: TrayDataChannelLike | null;
  open: boolean;
  openError: string | null;
}

export class LeaderTrayPeerManager {
  private readonly peerConnectionFactory: TrayPeerConnectionFactory;
  private readonly dataChannelLabel: string;
  private readonly peers = new Map<string, ActiveLeaderPeer>();

  constructor(private readonly options: LeaderTrayPeerManagerOptions) {
    this.peerConnectionFactory = options.peerConnectionFactory ?? createBrowserPeerConnection;
    this.dataChannelLabel = options.dataChannelLabel ?? DEFAULT_DATA_CHANNEL_LABEL;
  }

  async handleControlMessage(message: WorkerToLeaderControlMessage): Promise<void> {
    if (message.type === 'follower.join_requested') {
      await this.handleJoinRequested(message);
    } else if (message.type === 'bootstrap.answer') {
      await this.peers.get(message.bootstrapId)?.peer.setRemoteDescription(message.answer);
    } else if (message.type === 'bootstrap.ice_candidate') {
      await this.peers.get(message.bootstrapId)?.peer.addIceCandidate(message.candidate);
    }
  }

  getPeers(): LeaderTrayPeerState[] {
    return Array.from(this.peers.values()).map(({ state }) => ({ ...state }));
  }

  stop(): void {
    for (const active of this.peers.values()) {
      active.peer.close();
    }
    this.peers.clear();
  }

  private async handleJoinRequested(message: FollowerJoinRequestedMessage): Promise<void> {
    this.closeControllerPeers(message.controllerId);
    const peer = this.peerConnectionFactory();
    const state: LeaderTrayPeerState = {
      controllerId: message.controllerId,
      bootstrapId: message.bootstrapId,
      attempt: message.attempt,
      state: 'connecting',
      connectedAt: null,
    };
    this.peers.set(message.bootstrapId, { state, peer });

    peer.addEventListener('icecandidate', ({ candidate }) => {
      const normalized = normalizeIceCandidate(candidate);
      if (!normalized) return;
      this.options.sendControlMessage({
        type: 'bootstrap.ice_candidate',
        controllerId: message.controllerId,
        bootstrapId: message.bootstrapId,
        candidate: normalized,
      });
    });
    peer.addEventListener('connectionstatechange', () => {
      if (peer.connectionState === 'failed') {
        this.failPeer(message, 'Leader peer connection failed before the data channel opened');
      }
    });

    const channel = peer.createDataChannel(this.dataChannelLabel);
    channel.addEventListener('open', () => {
      const active = this.peers.get(message.bootstrapId);
      if (!active || active.state.state === 'connected') return;
      active.state.state = 'connected';
      active.state.connectedAt = new Date().toISOString();
      this.options.onPeerConnected?.({ ...active.state });
    });
    channel.addEventListener('close', () => {
      if (this.peers.get(message.bootstrapId)?.state.state !== 'connected') {
        this.failPeer(message, 'Leader data channel closed before opening');
      }
    });
    channel.addEventListener('error', () => {
      if (this.peers.get(message.bootstrapId)?.state.state !== 'connected') {
        this.failPeer(message, 'Leader data channel failed before opening');
      }
    });

    try {
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      this.options.sendControlMessage({
        type: 'bootstrap.offer',
        controllerId: message.controllerId,
        bootstrapId: message.bootstrapId,
        offer: normalizeSessionDescription(peer.localDescription ?? offer, 'offer'),
      });
    } catch (error) {
      this.failPeer(message, error instanceof Error ? error.message : String(error));
    }
  }

  private closeControllerPeers(controllerId: string): void {
    for (const [bootstrapId, active] of this.peers.entries()) {
      if (active.state.controllerId === controllerId) {
        active.peer.close();
        this.peers.delete(bootstrapId);
      }
    }
  }

  private failPeer(message: FollowerJoinRequestedMessage, reason: string): void {
    const active = this.peers.get(message.bootstrapId);
    if (!active) return;
    active.peer.close();
    this.peers.delete(message.bootstrapId);
    try {
      this.options.sendControlMessage({
        type: 'bootstrap.failed',
        controllerId: message.controllerId,
        bootstrapId: message.bootstrapId,
        code: 'WEBRTC_BOOTSTRAP_FAILED',
        message: reason,
        retryable: true,
        retryAfterMs: 1000,
      });
    } catch (error) {
      log.warn('Failed to report tray bootstrap failure', { error: error instanceof Error ? error.message : String(error) });
    }
  }
}

export class FollowerTrayManager {
  private readonly fetchImpl: typeof fetch;
  private readonly peerConnectionFactory: TrayPeerConnectionFactory;
  private readonly controllerIdFactory: () => string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollIntervalMs: number;
  private activePeer: ActiveFollowerPeer | null = null;
  private stopped = false;

  constructor(private readonly options: FollowerTrayManagerOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.peerConnectionFactory = options.peerConnectionFactory ?? createBrowserPeerConnection;
    this.controllerIdFactory = options.controllerIdFactory ?? (() => crypto.randomUUID());
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  async start(): Promise<FollowerTrayConnection> {
    this.stopped = false;
    const controllerId = this.controllerIdFactory();

    setFollowerTrayRuntimeStatus({
      state: 'connecting',
      joinUrl: this.options.joinUrl,
      trayId: null,
      error: null,
    });
    log.info('Follower tray join starting', { joinUrl: this.options.joinUrl });

    for (;;) {
      ensureNotStopped(this.stopped);
      const attach = await attachTrayFollower({
        joinUrl: this.options.joinUrl,
        controllerId,
        runtime: this.options.runtime,
        fetchImpl: this.fetchImpl,
      });
      if (attach.action === 'wait') {
        await this.sleep(attach.retryAfterMs ?? 1000);
        continue;
      }
      if (attach.action === 'fail' || !attach.bootstrap) {
        const errorMsg = attach.error ?? `Tray follower attach failed (${attach.code})`;
        setFollowerTrayRuntimeStatus({
          state: 'error',
          joinUrl: this.options.joinUrl,
          trayId: null,
          error: errorMsg,
        });
        log.warn('Follower tray attach failed', { error: errorMsg });
        throw new Error(errorMsg);
      }
      try {
        const connection = await this.completeBootstrap(attach.trayId, controllerId, attach.bootstrap);
        setFollowerTrayRuntimeStatus({
          state: 'connected',
          joinUrl: this.options.joinUrl,
          trayId: connection.trayId,
          error: null,
        });
        log.info('Follower tray connected', { trayId: connection.trayId, controllerId });
        return connection;
      } catch (error) {
        setFollowerTrayRuntimeStatus({
          state: 'error',
          joinUrl: this.options.joinUrl,
          trayId: attach.trayId,
          error: error instanceof Error ? error.message : String(error),
        });
        log.warn('Follower tray bootstrap failed', { error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    }
  }

  stop(): void {
    this.stopped = true;
    this.activePeer?.peer.close();
    this.activePeer?.channel?.close();
    this.activePeer = null;
    setFollowerTrayRuntimeStatus({
      state: 'inactive',
      joinUrl: null,
      trayId: null,
      error: null,
    });
  }

  private async completeBootstrap(
    trayId: string,
    controllerId: string,
    initialBootstrap: TrayBootstrapStatus,
  ): Promise<FollowerTrayConnection> {
    let bootstrap = initialBootstrap;
    let cursor = 0;
    this.activePeer = this.createFollowerPeer(controllerId, bootstrap.bootstrapId);

    for (;;) {
      ensureNotStopped(this.stopped);
      if (this.activePeer.open && this.activePeer.channel) {
        return { trayId, controllerId, bootstrapId: bootstrap.bootstrapId, channel: this.activePeer.channel };
      }
      if (this.activePeer.openError) {
        throw new Error(this.activePeer.openError);
      }

      const poll = await pollTrayFollowerBootstrap({
        joinUrl: this.options.joinUrl,
        controllerId,
        bootstrapId: bootstrap.bootstrapId,
        cursor,
        fetchImpl: this.fetchImpl,
      });
      bootstrap = poll.bootstrap;
      cursor = bootstrap.cursor;

      try {
        for (const event of poll.events) {
          if (event.type === 'bootstrap.offer') {
            await this.activePeer.peer.setRemoteDescription(event.offer);
            const answer = await this.activePeer.peer.createAnswer();
            await this.activePeer.peer.setLocalDescription(answer);
            await sendTrayFollowerAnswer({
              joinUrl: this.options.joinUrl,
              controllerId,
              bootstrapId: bootstrap.bootstrapId,
              answer: normalizeSessionDescription(this.activePeer.peer.localDescription ?? answer, 'answer'),
              fetchImpl: this.fetchImpl,
            });
          } else if (event.type === 'bootstrap.ice_candidate') {
            await this.activePeer.peer.addIceCandidate(event.candidate);
          } else if (event.type === 'bootstrap.failed') {
            throw new Error(event.failure.message);
          }
        }
      } catch (error) {
        if (bootstrap.failure?.retryable && bootstrap.retriesRemaining > 0) {
          const retry = await retryTrayFollowerBootstrap({
            joinUrl: this.options.joinUrl,
            controllerId,
            bootstrapId: bootstrap.bootstrapId,
            runtime: this.options.runtime,
            fetchImpl: this.fetchImpl,
          });
          bootstrap = retry.bootstrap;
          cursor = 0;
          this.activePeer.peer.close();
          this.activePeer = this.createFollowerPeer(controllerId, bootstrap.bootstrapId);
          continue;
        }
        throw error;
      }

      if (!this.activePeer.open) {
        await this.sleep(this.pollIntervalMs);
      }
    }
  }

  private createFollowerPeer(controllerId: string, bootstrapId: string): ActiveFollowerPeer {
    const peer = this.peerConnectionFactory();
    const active: ActiveFollowerPeer = { peer, channel: null, open: false, openError: null };
    peer.addEventListener('datachannel', ({ channel }) => {
      active.channel = channel;
      channel.addEventListener('open', () => {
        active.open = true;
      });
      channel.addEventListener('close', () => {
        if (!active.open) active.openError = 'Follower data channel closed before opening';
      });
      channel.addEventListener('error', () => {
        if (!active.open) active.openError = 'Follower data channel failed before opening';
      });
    });
    peer.addEventListener('icecandidate', ({ candidate }) => {
      const normalized = normalizeIceCandidate(candidate);
      if (!normalized) return;
      void sendTrayFollowerIceCandidate({
        joinUrl: this.options.joinUrl,
        controllerId,
        bootstrapId,
        candidate: normalized,
        fetchImpl: this.fetchImpl,
      }).catch((error) => {
        log.warn('Failed to send follower ICE candidate', { error: error instanceof Error ? error.message : String(error) });
      });
    });
    return active;
  }
}

function createBrowserPeerConnection(): TrayPeerConnectionLike {
  if (typeof RTCPeerConnection === 'undefined') {
    throw new Error('RTCPeerConnection is not available in this runtime');
  }
  return new RTCPeerConnection() as unknown as TrayPeerConnectionLike;
}

function normalizeSessionDescription(
  description: TraySessionDescription | null | undefined,
  expectedType: 'offer' | 'answer',
): TraySessionDescription {
  if (!description || description.type !== expectedType || typeof description.sdp !== 'string') {
    throw new Error(`Expected a local ${expectedType} description before signaling`);
  }
  return { type: description.type, sdp: description.sdp };
}

function normalizeIceCandidate(candidate: unknown): TrayIceCandidate | null {
  if (!candidate || typeof candidate !== 'object') return null;
  const value = candidate as Record<string, unknown>;
  return typeof value['candidate'] === 'string'
    ? {
        candidate: value['candidate'],
        sdpMid: typeof value['sdpMid'] === 'string' ? value['sdpMid'] : null,
        sdpMLineIndex: typeof value['sdpMLineIndex'] === 'number' ? value['sdpMLineIndex'] : null,
        usernameFragment: typeof value['usernameFragment'] === 'string' ? value['usernameFragment'] : null,
      }
    : null;
}

function ensureNotStopped(stopped: boolean): void {
  if (stopped) {
    throw new Error('Tray follower stopped before WebRTC bootstrap completed');
  }
}