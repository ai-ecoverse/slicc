import type {
  BootstrapAnswerMessage,
  FollowerBiscottoIdentity,
  FollowerJoinRequestedMessage,
  FollowerTrust,
  LeaderToWorkerControlMessage,
  TrayBootstrapEvent,
  TrayBootstrapStatus,
  TrayIceCandidate,
  TraySessionDescription,
  WorkerToLeaderControlMessage,
} from '@slicc/shared-ts';
import { createLogger } from '../base/logger.js';
import {
  attachTrayFollower,
  type FollowerAttachPlan,
  pollTrayFollowerBootstrap,
  retryTrayFollowerBootstrap,
  sendTrayFollowerAnswer,
  sendTrayFollowerIceCandidate,
} from './tray-follower.js';
import {
  type FollowerTrayRuntimeStatus,
  getFollowerTrayRuntimeStatus,
  setFollowerTrayRuntimeStatus,
} from './tray-follower-status.js';

const log = createLogger('tray-webrtc');
const DEFAULT_DATA_CHANNEL_LABEL = 'tray-control';
const DEFAULT_POLL_INTERVAL_MS = 250;
const MAX_SUPERSEDE_REDIRECTS = 5;
const SUPERSEDE_REDIRECT_DELAY_MS = 1000;

export interface TrayDataChannelLike {
  readyState?: string;

  bufferedAmount?: number;

  getMaxMessageSize?: () => number | undefined;
  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: string }) => void): void;
  send(data: string): void;
  close(): void;
}

export interface TrayPeerConnectionLike {
  localDescription?: TraySessionDescription | null;
  connectionState?: string;

  sctp?: { maxMessageSize?: number } | null;
  createDataChannel(label: string): TrayDataChannelLike;
  createOffer(): Promise<TraySessionDescription>;
  createAnswer(): Promise<TraySessionDescription>;
  setLocalDescription(description: TraySessionDescription): Promise<void>;
  setRemoteDescription(description: TraySessionDescription): Promise<void>;
  addIceCandidate(candidate: TrayIceCandidate): Promise<void>;
  addEventListener(type: 'icecandidate', listener: (event: { candidate: unknown }) => void): void;
  addEventListener(
    type: 'datachannel',
    listener: (event: { channel: TrayDataChannelLike }) => void
  ): void;
  addEventListener(type: 'connectionstatechange', listener: () => void): void;
  close(): void;
}

export interface TrayIceServerConfig {
  urls: string[];
  username: string;
  credential: string;
}

export type TrayPeerConnectionFactory = () => TrayPeerConnectionLike;

export interface LeaderTrayPeerState {
  controllerId: string;
  bootstrapId: string;
  attempt: number;
  state: 'connecting' | 'connected';
  connectedAt: string | null;
  runtime?: string;

  trust: FollowerTrust;

  biscotto?: FollowerBiscottoIdentity;
}

export interface LeaderTrayPeerManagerOptions {
  sendControlMessage: (message: LeaderToWorkerControlMessage) => void;
  peerConnectionFactory?: TrayPeerConnectionFactory;
  dataChannelLabel?: string;

  onPeersChanged?: () => void;
  onPeerConnected?: (peer: LeaderTrayPeerState, channel: TrayDataChannelLike) => void;

  onPeerDisconnected?: (bootstrapId: string, reason: string) => void;

  onPeerTransportClosed?: (bootstrapId: string, reason: string) => void;
  iceServers?: TrayIceServerConfig[];
}

export interface FollowerTrayConnection {
  trayId: string;
  controllerId: string;
  bootstrapId: string;
  channel: TrayDataChannelLike;
}

export interface FollowerTrayStatusSink {
  get(): FollowerTrayRuntimeStatus;
  set(status: FollowerTrayRuntimeStatus): void;
}

export const globalFollowerTrayStatusSink: FollowerTrayStatusSink = {
  get: getFollowerTrayRuntimeStatus,
  set: setFollowerTrayRuntimeStatus,
};

export interface FollowerTrayManagerOptions {
  joinUrl: string;
  runtime: string;
  fetchImpl?: typeof fetch;
  peerConnectionFactory?: TrayPeerConnectionFactory;
  controllerIdFactory?: () => string;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  iceServers?: TrayIceServerConfig[];

  onDisconnected?: (reason: string) => void;

  statusSink?: FollowerTrayStatusSink;

  onJoinUrlChanged?: (newJoinUrl: string) => void;
}

interface ActiveLeaderPeer {
  state: LeaderTrayPeerState;
  peer: TrayPeerConnectionLike;
  channel: TrayDataChannelLike;
}

interface ActiveFollowerPeer {
  peer: TrayPeerConnectionLike;
  channel: TrayDataChannelLike | null;
  open: boolean;
  openError: string | null;
}

const MAX_TIMEOUT_MS = 2_147_483_647;

const LEADER_PEER_CONNECT_GRACE_MS = 10_000;

const LEADER_PEER_CONNECT_FALLBACK_MS = 30_000;

const LEADER_PEER_CONNECT_MAX_MS = 5 * 60_000;

const LEADER_PEER_DISCONNECTED_GRACE_MS = 60_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class LeaderTrayPeerManager {
  private readonly peerConnectionFactory: TrayPeerConnectionFactory;
  private readonly dataChannelLabel: string;
  private readonly peers = new Map<string, ActiveLeaderPeer>();

  private readonly expiryTimers = new Map<string, { cancel: () => void }>();

  private readonly connectTimers = new Map<string, { cancel: () => void }>();

  private readonly peerSignal = new Map<string, Promise<void>>();

  private readonly pendingRemoteIce = new Map<string, TrayIceCandidate[]>();
  private readonly remoteAnswerReady = new Set<string>();

  private readonly pendingLocalIce = new Map<string, TrayIceCandidate[]>();
  private readonly offerSent = new Set<string>();
  private iceServers: TrayIceServerConfig[] | undefined;

  constructor(private readonly options: LeaderTrayPeerManagerOptions) {
    this.iceServers = options.iceServers;
    this.peerConnectionFactory =
      options.peerConnectionFactory ?? (() => createBrowserPeerConnection(this.iceServers));
    this.dataChannelLabel = options.dataChannelLabel ?? DEFAULT_DATA_CHANNEL_LABEL;
  }

  setIceServers(iceServers: TrayIceServerConfig[]): void {
    this.iceServers = iceServers;
  }

  async handleControlMessage(message: WorkerToLeaderControlMessage): Promise<void> {
    if (message.type === 'follower.join_requested') {
      if (message.iceServers && !this.iceServers) {
        this.iceServers = message.iceServers;
      }
      await this.handleJoinRequested(message);
    } else if (message.type === 'bootstrap.answer') {
      await this.enqueuePeerSignal(message.bootstrapId, () => this.applyRemoteAnswer(message));
    } else if (message.type === 'bootstrap.ice_candidate') {
      await this.enqueuePeerSignal(message.bootstrapId, () =>
        this.applyRemoteIce(message.bootstrapId, message.candidate)
      );
    } else if (message.type === 'biscotto.revoked') {
      this.closeBiscottoPeers(message.biscottoId, 'Biscotto revoked');
    }
  }

  getPeers(): LeaderTrayPeerState[] {
    return Array.from(this.peers.values()).map(({ state }) => ({ ...state }));
  }

  getChannel(bootstrapId: string): TrayDataChannelLike | null {
    return this.peers.get(bootstrapId)?.channel ?? null;
  }

  stop(): void {
    for (const active of this.peers.values()) {
      active.peer.close();
    }
    for (const timer of this.expiryTimers.values()) timer.cancel();
    this.expiryTimers.clear();
    for (const timer of this.connectTimers.values()) timer.cancel();
    this.connectTimers.clear();
    this.peerSignal.clear();
    this.pendingRemoteIce.clear();
    this.remoteAnswerReady.clear();
    this.pendingLocalIce.clear();
    this.offerSent.clear();
    this.peers.clear();
    this.options.onPeersChanged?.();
  }

  private async handleJoinRequested(message: FollowerJoinRequestedMessage): Promise<void> {
    this.closeControllerPeers(message.controllerId);
    const created = this.createLeaderPeer(message);
    if (!created) return;
    const { peer, channel } = created;
    const state: LeaderTrayPeerState = {
      controllerId: message.controllerId,
      bootstrapId: message.bootstrapId,
      attempt: message.attempt,
      state: 'connecting',
      connectedAt: null,
      runtime: message.runtime,
      trust: message.trust ?? 'full',
      biscotto: message.biscotto,
    };
    this.peers.set(message.bootstrapId, { state, peer, channel });
    this.armConnectDeadline(message);
    this.options.onPeersChanged?.();
    this.bindLeaderPeerEvents(message, peer, channel);

    try {
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      this.options.sendControlMessage({
        type: 'bootstrap.offer',
        controllerId: message.controllerId,
        bootstrapId: message.bootstrapId,
        offer: normalizeSessionDescription(peer.localDescription ?? offer, 'offer'),
      });

      this.releaseLocalIce(message.bootstrapId, message.controllerId);
    } catch (error) {
      this.failPeer(message, errorMessage(error));
    }
  }

  private createLeaderPeer(
    message: FollowerJoinRequestedMessage
  ): { peer: TrayPeerConnectionLike; channel: TrayDataChannelLike } | null {
    let peer: TrayPeerConnectionLike | null = null;
    try {
      peer = this.peerConnectionFactory();
      const channel = bindSctpLimit(peer.createDataChannel(this.dataChannelLabel), peer);
      return { peer, channel };
    } catch (error) {
      try {
        peer?.close();
      } catch {}
      const reason = errorMessage(error);
      log.error('Leader could not create a peer connection for a follower', {
        bootstrapId: message.bootstrapId,
        livePeers: this.peers.size,
        error: reason,
      });
      this.reportBootstrapFailure(message, `Leader could not create a peer connection: ${reason}`);
      return null;
    }
  }

  private bindLeaderPeerEvents(
    message: FollowerJoinRequestedMessage,
    peer: TrayPeerConnectionLike,
    channel: TrayDataChannelLike
  ): void {
    peer.addEventListener('icecandidate', ({ candidate }) => {
      const normalized = normalizeIceCandidate(candidate);
      if (!normalized) return;
      this.noteLocalIce(message.bootstrapId, message.controllerId, normalized);
    });
    peer.addEventListener('connectionstatechange', () =>
      this.onLeaderConnectionStateChange(message, peer.connectionState)
    );
    channel.addEventListener('open', () => {
      const active = this.peers.get(message.bootstrapId);
      if (!active || active.state.state === 'connected') return;
      this.cancelConnectDeadline(message.bootstrapId);
      active.state.state = 'connected';
      active.state.connectedAt = new Date().toISOString();
      this.armBiscottoExpiry(message.bootstrapId, active.state);
      this.options.onPeerConnected?.({ ...active.state }, active.channel);
      this.options.onPeersChanged?.();
    });
    channel.addEventListener('close', () => {
      const active = this.peers.get(message.bootstrapId);
      if (!active) return;
      if (active.state.state !== 'connected') {
        this.failPeer(message, 'Leader data channel closed before opening');
        return;
      }
      log.warn('Leader data channel closed post-connect', { bootstrapId: message.bootstrapId });
      this.options.onPeerDisconnected?.(message.bootstrapId, 'Data channel closed');
      this.releasePeer(message.bootstrapId, 'Data channel closed');
    });
    channel.addEventListener('error', () => {
      const active = this.peers.get(message.bootstrapId);
      if (!active) return;
      if (active.state.state !== 'connected') {
        this.failPeer(message, 'Leader data channel failed before opening');
      } else {
        log.warn('Leader data channel error post-connect', { bootstrapId: message.bootstrapId });
        this.options.onPeerDisconnected?.(message.bootstrapId, 'Data channel error');
      }
    });
  }

  private onLeaderConnectionStateChange(
    message: FollowerJoinRequestedMessage,
    connectionState: string | undefined
  ): void {
    const active = this.peers.get(message.bootstrapId);
    if (!active) return;
    if (active.state.state !== 'connected') {
      if (connectionState === 'failed') {
        this.failPeer(message, 'Leader peer connection failed before the data channel opened');
      }
      return;
    }
    if (connectionState === 'disconnected' || connectionState === 'failed') {
      log.warn('Leader peer connection state changed post-connect', {
        bootstrapId: message.bootstrapId,
        state: connectionState,
      });
      this.options.onPeerDisconnected?.(message.bootstrapId, `Peer connection ${connectionState}`);
    }

    if (connectionState === 'failed' || connectionState === 'closed') {
      this.releasePeer(message.bootstrapId, `Peer connection ${connectionState}`);
    } else if (connectionState === 'disconnected') {
      this.armDisconnectedDeadline(message.bootstrapId);
    } else if (connectionState === 'connected') {
      this.cancelConnectDeadline(message.bootstrapId);
    }
  }

  private armDisconnectedDeadline(bootstrapId: string): void {
    if (this.connectTimers.has(bootstrapId)) return;
    const handle = setTimeout(() => {
      this.connectTimers.delete(bootstrapId);
      if (this.peers.get(bootstrapId)?.peer.connectionState !== 'disconnected') return;
      log.warn('Leader peer stayed disconnected; releasing it', { bootstrapId });
      this.releasePeer(bootstrapId, 'Peer connection did not recover from disconnected');
    }, LEADER_PEER_DISCONNECTED_GRACE_MS);
    this.connectTimers.set(bootstrapId, { cancel: () => clearTimeout(handle) });
  }

  closeBiscottoPeers(biscottoId: string, reason: string): void {
    for (const [bootstrapId, active] of [...this.peers.entries()]) {
      if (active.state.biscotto?.id !== biscottoId) continue;
      if (active.state.state === 'connected') {
        this.options.onPeerDisconnected?.(bootstrapId, reason);
      }
      this.releasePeer(bootstrapId, reason, false);
    }
    this.options.onPeersChanged?.();
  }

  private armBiscottoExpiry(bootstrapId: string, state: LeaderTrayPeerState): void {
    const expiresAt = state.biscotto?.expiresAt;
    const biscottoId = state.biscotto?.id;
    if (!expiresAt || !biscottoId) return;
    const parsed = Date.parse(expiresAt);
    if (Number.isNaN(parsed)) return;

    const remaining = Math.max(0, parsed - Date.now());
    const delay = Math.min(remaining, MAX_TIMEOUT_MS);
    const handle = setTimeout(() => {
      this.expiryTimers.delete(bootstrapId);
      if (Date.now() >= parsed) {
        this.closeBiscottoPeers(biscottoId, 'Biscotto expired');
      } else if (this.peers.has(bootstrapId)) {
        this.armBiscottoExpiry(bootstrapId, state);
      }
    }, delay);
    this.expiryTimers.set(bootstrapId, { cancel: () => clearTimeout(handle) });
  }

  private armConnectDeadline(message: FollowerJoinRequestedMessage): void {
    const expiresAtMs = message.expiresAt ? Date.parse(message.expiresAt) : Number.NaN;
    const untilExpiry = Number.isNaN(expiresAtMs)
      ? LEADER_PEER_CONNECT_FALLBACK_MS
      : expiresAtMs - Date.now() + LEADER_PEER_CONNECT_GRACE_MS;
    const delay = Math.min(
      Math.max(untilExpiry, LEADER_PEER_CONNECT_GRACE_MS),
      LEADER_PEER_CONNECT_MAX_MS
    );
    const handle = setTimeout(() => {
      this.connectTimers.delete(message.bootstrapId);
      const active = this.peers.get(message.bootstrapId);
      if (!active || active.state.state === 'connected') return;
      this.failPeer(message, 'Follower did not connect before the bootstrap expired');
    }, delay);
    this.connectTimers.set(message.bootstrapId, { cancel: () => clearTimeout(handle) });
  }

  private cancelConnectDeadline(bootstrapId: string): void {
    this.connectTimers.get(bootstrapId)?.cancel();
    this.connectTimers.delete(bootstrapId);
  }

  private closeControllerPeers(controllerId: string): void {
    for (const [bootstrapId, active] of [...this.peers.entries()]) {
      if (active.state.controllerId !== controllerId) continue;
      if (active.state.state === 'connected') {
        this.options.onPeerDisconnected?.(bootstrapId, 'Controller superseded');
      }
      this.releasePeer(bootstrapId, 'Controller superseded', false);
    }
  }

  private releasePeer(bootstrapId: string, reason: string, notifyPeersChanged = true): void {
    const active = this.peers.get(bootstrapId);
    if (!active) return;
    this.peers.delete(bootstrapId);
    this.cancelConnectDeadline(bootstrapId);
    this.expiryTimers.get(bootstrapId)?.cancel();
    this.expiryTimers.delete(bootstrapId);
    this.peerSignal.delete(bootstrapId);
    this.pendingRemoteIce.delete(bootstrapId);
    this.remoteAnswerReady.delete(bootstrapId);
    this.pendingLocalIce.delete(bootstrapId);
    this.offerSent.delete(bootstrapId);
    if (active.state.state === 'connected') {
      this.options.onPeerTransportClosed?.(bootstrapId, reason);
    }
    try {
      active.peer.close();
    } catch (error) {
      log.warn('Leader peer close failed', { bootstrapId, error: errorMessage(error) });
    }
    if (notifyPeersChanged) this.options.onPeersChanged?.();
  }

  private enqueuePeerSignal(bootstrapId: string, op: () => Promise<void>): Promise<void> {
    if (!this.peers.has(bootstrapId)) return Promise.resolve();
    const prev = this.peerSignal.get(bootstrapId) ?? Promise.resolve();
    const run = prev.then(op, op);
    const settled = run.then(
      () => undefined,
      () => undefined
    );
    this.peerSignal.set(bootstrapId, settled);
    void settled.then(() => {
      if (this.peerSignal.get(bootstrapId) === settled && !this.peers.has(bootstrapId)) {
        this.peerSignal.delete(bootstrapId);
      }
    });
    return run;
  }

  private async applyRemoteAnswer(message: BootstrapAnswerMessage): Promise<void> {
    const peer = this.peers.get(message.bootstrapId)?.peer;
    if (!peer) return;
    await peer.setRemoteDescription(message.answer);
    if (!this.peers.has(message.bootstrapId)) return;
    this.remoteAnswerReady.add(message.bootstrapId);
    const queued = this.pendingRemoteIce.get(message.bootstrapId) ?? [];
    this.pendingRemoteIce.delete(message.bootstrapId);
    for (const candidate of queued) {
      await this.peers.get(message.bootstrapId)?.peer.addIceCandidate(candidate);
    }
  }

  private async applyRemoteIce(bootstrapId: string, candidate: TrayIceCandidate): Promise<void> {
    if (!this.peers.has(bootstrapId)) return;
    if (!this.remoteAnswerReady.has(bootstrapId)) {
      const queued = this.pendingRemoteIce.get(bootstrapId) ?? [];
      queued.push(candidate);
      this.pendingRemoteIce.set(bootstrapId, queued);
      return;
    }
    await this.peers.get(bootstrapId)?.peer.addIceCandidate(candidate);
  }

  private noteLocalIce(
    bootstrapId: string,
    controllerId: string,
    candidate: TrayIceCandidate
  ): void {
    if (!this.peers.has(bootstrapId)) return;
    if (!this.offerSent.has(bootstrapId)) {
      const queued = this.pendingLocalIce.get(bootstrapId) ?? [];
      queued.push(candidate);
      this.pendingLocalIce.set(bootstrapId, queued);
      return;
    }
    this.emitLocalIce(controllerId, bootstrapId, candidate);
  }

  private releaseLocalIce(bootstrapId: string, controllerId: string): void {
    this.offerSent.add(bootstrapId);
    const queued = this.pendingLocalIce.get(bootstrapId) ?? [];
    this.pendingLocalIce.delete(bootstrapId);
    for (const candidate of queued) this.emitLocalIce(controllerId, bootstrapId, candidate);
  }

  private emitLocalIce(
    controllerId: string,
    bootstrapId: string,
    candidate: TrayIceCandidate
  ): void {
    this.options.sendControlMessage({
      type: 'bootstrap.ice_candidate',
      controllerId,
      bootstrapId,
      candidate,
    });
  }

  private failPeer(message: FollowerJoinRequestedMessage, reason: string): void {
    if (!this.peers.has(message.bootstrapId)) return;
    this.releasePeer(message.bootstrapId, reason);
    this.reportBootstrapFailure(message, reason);
  }

  private reportBootstrapFailure(message: FollowerJoinRequestedMessage, reason: string): void {
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
      log.warn('Failed to report tray bootstrap failure', { error: errorMessage(error) });
    }
  }
}

export class FollowerTrayManager {
  private readonly fetchImpl: typeof fetch;
  private readonly peerConnectionFactory: TrayPeerConnectionFactory;
  private readonly controllerIdFactory: () => string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollIntervalMs: number;
  private iceServers: TrayIceServerConfig[] | undefined;
  private activePeer: ActiveFollowerPeer | null = null;
  private stopped = false;

  private remoteOfferReady = false;
  private pendingRemoteIce: TrayIceCandidate[] = [];

  private answerSent = false;
  private pendingLocalIce: TrayIceCandidate[] = [];
  private readonly status: FollowerTrayStatusSink;

  constructor(private readonly options: FollowerTrayManagerOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.iceServers = options.iceServers;
    this.peerConnectionFactory =
      options.peerConnectionFactory ?? (() => createBrowserPeerConnection(this.iceServers));
    this.controllerIdFactory = options.controllerIdFactory ?? (() => crypto.randomUUID());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.status = options.statusSink ?? globalFollowerTrayStatusSink;
  }

  async start(): Promise<FollowerTrayConnection> {
    this.stopped = false;
    const controllerId = this.controllerIdFactory();
    const connectingSince = Date.now();

    this.status.set({
      state: 'connecting',
      joinUrl: this.options.joinUrl,
      trayId: null,
      error: null,
      lastPingTime: null,
      reconnectAttempts: 0,
      attachAttempts: 0,
      lastAttachCode: null,
      connectingSince,
      lastError: null,
    });
    log.info('Follower tray join starting', { joinUrl: this.options.joinUrl });

    let attachAttempt = 0;
    let supersedeRedirects = 0;
    for (;;) {
      ensureNotStopped(this.stopped);
      attachAttempt++;
      let attach;
      try {
        attach = await attachTrayFollower({
          joinUrl: this.options.joinUrl,
          controllerId,
          runtime: this.options.runtime,
          fetchImpl: this.fetchImpl,
        });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        this.status.set({
          ...this.status.get(),
          attachAttempts: attachAttempt,
          lastError: errorMsg,
        });
        throw error;
      }

      this.status.set({
        ...this.status.get(),
        attachAttempts: attachAttempt,
        lastAttachCode: attach.code,
      });

      if (this.followSupersededJoinUrl(attach, supersedeRedirects)) {
        supersedeRedirects++;
        await this.sleep(SUPERSEDE_REDIRECT_DELAY_MS);
        continue;
      }
      if (attach.action === 'wait') {
        const retryMs = attach.retryAfterMs ?? 1000;
        log.info('Follower tray attach waiting', {
          attempt: attachAttempt,
          code: attach.code,
          retryAfterMs: retryMs,
        });
        if (attachAttempt % 10 === 0) {
          log.warn(`Follower tray attach still waiting after ${attachAttempt} attempts`, {
            attempt: attachAttempt,
            code: attach.code,
            retryAfterMs: retryMs,
          });
        }
        await this.sleep(retryMs);
        continue;
      }
      if (attach.action === 'fail' || !attach.bootstrap) {
        const errorMsg = attach.error ?? `Tray follower attach failed (${attach.code})`;
        this.status.set({
          state: 'error',
          joinUrl: this.options.joinUrl,
          trayId: null,
          error: errorMsg,
          lastPingTime: null,
          reconnectAttempts: 0,
          attachAttempts: attachAttempt,
          lastAttachCode: attach.code,
          connectingSince: null,
          lastError: errorMsg,
        });
        log.warn('Follower tray attach failed', { error: errorMsg });
        throw new Error(errorMsg);
      }
      if (attach.iceServers) {
        this.iceServers = attach.iceServers;
      }
      try {
        const connection = await this.completeBootstrap(
          attach.trayId,
          controllerId,
          attach.bootstrap
        );
        this.status.set({
          state: 'connected',
          joinUrl: this.options.joinUrl,
          trayId: connection.trayId,
          error: null,
          lastPingTime: null,
          reconnectAttempts: 0,
          attachAttempts: attachAttempt,
          lastAttachCode: attach.code,
          connectingSince: null,
          lastError: null,
        });
        log.info('Follower tray connected', { trayId: connection.trayId, controllerId });
        return connection;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        this.status.set({
          state: 'error',
          joinUrl: this.options.joinUrl,
          trayId: attach.trayId,
          error: errorMsg,
          lastPingTime: null,
          reconnectAttempts: 0,
          attachAttempts: attachAttempt,
          lastAttachCode: attach.code,
          connectingSince: null,
          lastError: errorMsg,
        });
        log.warn('Follower tray bootstrap failed', { error: errorMsg });
        throw error;
      }
    }
  }

  private followSupersededJoinUrl(attach: FollowerAttachPlan, redirectCount: number): boolean {
    if (
      attach.action !== 'fail' ||
      attach.code !== 'TRAY_SUPERSEDED' ||
      !attach.supersededByJoinUrl
    ) {
      return false;
    }
    if (redirectCount >= MAX_SUPERSEDE_REDIRECTS) {
      throw new Error(
        `Follower tray attach gave up after ${redirectCount} supersede redirects (possible redirect cycle)`
      );
    }
    let newJoinUrl: URL;
    try {
      newJoinUrl = new URL(attach.supersededByJoinUrl);
    } catch {
      throw new Error(
        `Follower tray superseded with an invalid joinUrl: ${attach.supersededByJoinUrl}`
      );
    }
    log.info('Follower tray superseded, following redirect', {
      oldJoinUrl: this.options.joinUrl,
      newJoinUrl: newJoinUrl.toString(),
    });
    this.options.joinUrl = newJoinUrl.toString();
    this.options.onJoinUrlChanged?.(newJoinUrl.toString());
    return true;
  }

  stop(): void {
    this.stopped = true;
    this.activePeer?.peer.close();
    this.activePeer?.channel?.close();
    this.activePeer = null;
    this.resetTrickle();
    this.status.set({
      state: 'inactive',
      joinUrl: null,
      trayId: null,
      error: null,
      lastPingTime: null,
      reconnectAttempts: 0,
      attachAttempts: 0,
      lastAttachCode: null,
      connectingSince: null,
      lastError: null,
    });
  }

  private async completeBootstrap(
    trayId: string,
    controllerId: string,
    initialBootstrap: TrayBootstrapStatus
  ): Promise<FollowerTrayConnection> {
    let bootstrap = initialBootstrap;
    let cursor = 0;
    this.activePeer = this.createFollowerPeer(controllerId, bootstrap.bootstrapId);

    for (;;) {
      ensureNotStopped(this.stopped);
      if (this.activePeer.open && this.activePeer.channel) {
        return {
          trayId,
          controllerId,
          bootstrapId: bootstrap.bootstrapId,
          channel: this.activePeer.channel,
        };
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
        await this.applyBootstrapEvents(
          poll.events,
          this.activePeer,
          controllerId,
          bootstrap.bootstrapId
        );
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

  private async applyBootstrapEvents(
    events: TrayBootstrapEvent[],
    activePeer: ActiveFollowerPeer,
    controllerId: string,
    bootstrapId: string
  ): Promise<void> {
    for (const event of events) {
      await this.applyOneBootstrapEvent(event, activePeer, controllerId, bootstrapId);
    }
  }

  private async applyOneBootstrapEvent(
    event: TrayBootstrapEvent,
    activePeer: ActiveFollowerPeer,
    controllerId: string,
    bootstrapId: string
  ): Promise<void> {
    if (event.type === 'bootstrap.offer') {
      await this.applyRemoteOffer(event.offer, activePeer, controllerId, bootstrapId);
      return;
    }
    if (event.type === 'bootstrap.ice_candidate') {
      await this.holdOrAddRemoteIce(activePeer, event.candidate);
      return;
    }
    if (event.type === 'bootstrap.failed') {
      throw new Error(event.failure.message);
    }
  }

  private async holdOrAddRemoteIce(
    activePeer: ActiveFollowerPeer,
    candidate: TrayIceCandidate
  ): Promise<void> {
    if (!this.remoteOfferReady) {
      this.pendingRemoteIce.push(candidate);
      return;
    }
    await activePeer.peer.addIceCandidate(candidate);
  }

  private async applyRemoteOffer(
    offer: TraySessionDescription,
    activePeer: ActiveFollowerPeer,
    controllerId: string,
    bootstrapId: string
  ): Promise<void> {
    await activePeer.peer.setRemoteDescription(offer);
    this.remoteOfferReady = true;
    const queued = this.pendingRemoteIce;
    this.pendingRemoteIce = [];
    for (const candidate of queued) {
      await activePeer.peer.addIceCandidate(candidate);
    }
    const answer = await activePeer.peer.createAnswer();
    await activePeer.peer.setLocalDescription(answer);
    await sendTrayFollowerAnswer({
      joinUrl: this.options.joinUrl,
      controllerId,
      bootstrapId,
      answer: normalizeSessionDescription(activePeer.peer.localDescription ?? answer, 'answer'),
      fetchImpl: this.fetchImpl,
    });

    this.releaseLocalIce(controllerId, bootstrapId);
  }

  private resetTrickle(): void {
    this.remoteOfferReady = false;
    this.pendingRemoteIce = [];
    this.answerSent = false;
    this.pendingLocalIce = [];
  }

  private createFollowerPeer(controllerId: string, bootstrapId: string): ActiveFollowerPeer {
    this.resetTrickle();
    const peer = this.peerConnectionFactory();
    const active: ActiveFollowerPeer = { peer, channel: null, open: false, openError: null };
    peer.addEventListener('connectionstatechange', () => {
      if (!active.open) {
        return;
      }
      if (peer.connectionState === 'disconnected' || peer.connectionState === 'failed') {
        log.warn('Follower peer connection state changed post-connect', {
          bootstrapId,
          state: peer.connectionState,
        });
        this.options.onDisconnected?.(`Peer connection ${peer.connectionState}`);
      }
    });
    peer.addEventListener('datachannel', ({ channel }) => {
      active.channel = bindSctpLimit(channel, peer);
      channel.addEventListener('open', () => {
        active.open = true;
      });
      channel.addEventListener('close', () => {
        if (!active.open) {
          active.openError = 'Follower data channel closed before opening';
        } else {
          log.warn('Follower data channel closed post-connect', { bootstrapId });
          this.options.onDisconnected?.('Data channel closed');
        }
      });
      channel.addEventListener('error', () => {
        if (!active.open) {
          active.openError = 'Follower data channel failed before opening';
        } else {
          log.warn('Follower data channel error post-connect', { bootstrapId });
          this.options.onDisconnected?.('Data channel error');
        }
      });
    });
    peer.addEventListener('icecandidate', ({ candidate }) => {
      if (this.activePeer?.peer !== peer) return;
      const normalized = normalizeIceCandidate(candidate);
      if (!normalized) return;
      this.noteLocalIce(controllerId, bootstrapId, normalized);
    });
    return active;
  }

  private noteLocalIce(
    controllerId: string,
    bootstrapId: string,
    candidate: TrayIceCandidate
  ): void {
    if (!this.answerSent) {
      this.pendingLocalIce.push(candidate);
      return;
    }
    void this.postLocalIce(controllerId, bootstrapId, candidate);
  }

  private releaseLocalIce(controllerId: string, bootstrapId: string): void {
    this.answerSent = true;
    const queued = this.pendingLocalIce;
    this.pendingLocalIce = [];
    for (const candidate of queued) {
      void this.postLocalIce(controllerId, bootstrapId, candidate);
    }
  }

  private async postLocalIce(
    controllerId: string,
    bootstrapId: string,
    candidate: TrayIceCandidate
  ): Promise<void> {
    try {
      await sendTrayFollowerIceCandidate({
        joinUrl: this.options.joinUrl,
        controllerId,
        bootstrapId,
        candidate,
        fetchImpl: this.fetchImpl,
      });
    } catch (error) {
      log.warn('Failed to send follower ICE candidate', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export interface FollowerAutoReconnectOptions {
  baseDelayMs?: number;

  backoffMultiplier?: number;

  maxDelayMs?: number;

  maxAttempts?: number;

  onConnected: (connection: FollowerTrayConnection) => void;

  onReconnecting?: (attempt: number) => void;

  onGaveUp?: (lastError: string) => void;

  sleep?: (ms: number) => Promise<void>;
}

export interface FollowerAutoReconnectHandle {
  cancel(): void;

  readonly reconnecting: boolean;
}

export function startFollowerWithAutoReconnect(
  managerOptions: FollowerTrayManagerOptions,
  reconnectOptions: FollowerAutoReconnectOptions
): FollowerAutoReconnectHandle {
  const baseDelay = reconnectOptions.baseDelayMs ?? 1000;
  const multiplier = reconnectOptions.backoffMultiplier ?? 2;
  const maxDelay = reconnectOptions.maxDelayMs ?? 30_000;
  const maxAttempts = reconnectOptions.maxAttempts ?? 10;
  const status = managerOptions.statusSink ?? globalFollowerTrayStatusSink;
  const sleepFn =
    reconnectOptions.sleep ??
    managerOptions.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let cancelled = false;
  let reconnecting = false;
  let activeManager: FollowerTrayManager | null = null;

  const handle: FollowerAutoReconnectHandle = {
    cancel() {
      cancelled = true;
      reconnecting = false;
      activeManager?.stop();
      activeManager = null;
    },
    get reconnecting() {
      return reconnecting;
    },
  };

  const connectOnce = (): {
    manager: FollowerTrayManager;
    connectionPromise: Promise<FollowerTrayConnection>;
  } => {
    const manager = new FollowerTrayManager({
      ...managerOptions,
      sleep: sleepFn,
      onDisconnected: (reason: string) => {
        if (cancelled) return;
        log.warn('Follower disconnected, starting reconnect loop', { reason });
        void reconnectLoop(reason);
      },
      onJoinUrlChanged: (newJoinUrl: string) => {
        managerOptions.joinUrl = newJoinUrl;
        managerOptions.onJoinUrlChanged?.(newJoinUrl);
      },
    });
    activeManager = manager;
    return { manager, connectionPromise: manager.start() };
  };

  const reconnectLoop = async (initialReason?: string): Promise<void> => {
    if (cancelled || reconnecting) return;
    reconnecting = true;

    activeManager?.stop();
    activeManager = null;

    let attempt = 0;
    let delay = baseDelay;
    let lastError = initialReason ?? 'Unknown disconnect';

    while (!cancelled && attempt < maxAttempts) {
      attempt++;
      reconnectOptions.onReconnecting?.(attempt);
      status.set({
        ...status.get(),
        state: 'reconnecting',
        error: null,
        reconnectAttempts: attempt,
      });

      log.info('Reconnect attempt', { attempt, delay });
      await sleepFn(delay);
      if (cancelled) break;

      let manager: FollowerTrayManager | null = null;
      try {
        const result = connectOnce();
        manager = result.manager;
        const connection = await result.connectionPromise;

        if (cancelled) {
          manager.stop();
          break;
        }

        reconnecting = false;
        status.set({
          ...status.get(),
          state: 'connected',
          joinUrl: managerOptions.joinUrl,
          trayId: connection.trayId,
          error: null,
          lastPingTime: null,
          reconnectAttempts: 0,
          connectingSince: null,
          lastError: null,
        });
        log.info('Reconnect successful', { attempt, trayId: connection.trayId });
        reconnectOptions.onConnected(connection);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        log.warn('Reconnect attempt failed', { attempt, error: lastError });

        manager?.stop();
        activeManager = null;
      }

      delay = Math.min(delay * multiplier, maxDelay);
    }

    if (!cancelled) {
      reconnecting = false;
      status.set({
        ...status.get(),
        state: 'error',
        error: `Reconnect failed after ${attempt} attempts: ${lastError}`,
        reconnectAttempts: attempt,
      });
      log.warn('Reconnect gave up', { attempts: attempt, lastError });
      reconnectOptions.onGaveUp?.(lastError);
    }
  };

  const { connectionPromise } = connectOnce();
  void connectionPromise
    .then((connection) => {
      if (cancelled) return;
      reconnectOptions.onConnected(connection);
    })
    .catch((error) => {
      if (cancelled) return;

      log.error('Initial follower connection failed', {
        error: error instanceof Error ? error.message : String(error),
      });

      void reconnectLoop(error instanceof Error ? error.message : String(error));
    });

  return handle;
}

function bindSctpLimit(
  channel: TrayDataChannelLike,
  peer: TrayPeerConnectionLike
): TrayDataChannelLike {
  channel.getMaxMessageSize = () => peer.sctp?.maxMessageSize;
  return channel;
}

function createBrowserPeerConnection(iceServers?: TrayIceServerConfig[]): TrayPeerConnectionLike {
  if (typeof RTCPeerConnection === 'undefined') {
    throw new Error('RTCPeerConnection is not available in this runtime');
  }
  const config = iceServers?.length ? { iceServers } : undefined;
  return new RTCPeerConnection(config) as unknown as TrayPeerConnectionLike;
}

function normalizeSessionDescription(
  description: TraySessionDescription | null | undefined,
  expectedType: 'offer' | 'answer'
): TraySessionDescription {
  if (!description || description.type !== expectedType || typeof description.sdp !== 'string') {
    throw new Error(`Expected a local ${expectedType} description before signaling`);
  }
  return { type: description.type, sdp: description.sdp };
}

interface RawIceCandidate {
  candidate?: unknown;
  sdpMid?: unknown;
  sdpMLineIndex?: unknown;
  usernameFragment?: unknown;
}

function normalizeIceCandidate(candidate: unknown): TrayIceCandidate | null {
  if (!candidate || typeof candidate !== 'object') return null;
  const value = candidate as RawIceCandidate;
  return typeof value.candidate === 'string'
    ? {
        candidate: value.candidate,
        sdpMid: typeof value.sdpMid === 'string' ? value.sdpMid : null,
        sdpMLineIndex: typeof value.sdpMLineIndex === 'number' ? value.sdpMLineIndex : null,
        usernameFragment:
          typeof value.usernameFragment === 'string' ? value.usernameFragment : null,
      }
    : null;
}

function ensureNotStopped(stopped: boolean): void {
  if (stopped) {
    throw new Error('Tray follower stopped before WebRTC bootstrap completed');
  }
}
