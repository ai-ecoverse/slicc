import { createLogger } from '../core/logger.js';
import type {
  LeaderToWorkerControlMessage,
  WorkerToLeaderControlMessage,
  FollowerJoinRequestedMessage,
  TrayBootstrapStatus,
  TrayIceCandidate,
  TraySessionDescription,
} from './tray-types.js';
import {
  attachTrayFollower,
  pollTrayFollowerBootstrap,
  retryTrayFollowerBootstrap,
  sendTrayFollowerAnswer,
  sendTrayFollowerIceCandidate,
} from './tray-follower.js';
import {
  setFollowerTrayRuntimeStatus,
  getFollowerTrayRuntimeStatus,
} from './tray-follower-status.js';

const log = createLogger('tray-webrtc');
const DEFAULT_DATA_CHANNEL_LABEL = 'tray-control';
const DEFAULT_POLL_INTERVAL_MS = 250;

export interface TrayDataChannelLike {
  readyState?: string;
  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: string }) => void): void;
  send(data: string): void;
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
}

export interface LeaderTrayPeerManagerOptions {
  sendControlMessage: (message: LeaderToWorkerControlMessage) => void;
  peerConnectionFactory?: TrayPeerConnectionFactory;
  dataChannelLabel?: string;
  onPeerConnected?: (peer: LeaderTrayPeerState, channel: TrayDataChannelLike) => void;
  /** Called when an established peer connection transitions to 'disconnected' or 'failed'. */
  onPeerDisconnected?: (bootstrapId: string, reason: string) => void;
  iceServers?: TrayIceServerConfig[];
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
  iceServers?: TrayIceServerConfig[];
  /** Called when an established peer connection transitions to 'disconnected' or 'failed'. */
  onDisconnected?: (reason: string) => void;
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

export class LeaderTrayPeerManager {
  private readonly peerConnectionFactory: TrayPeerConnectionFactory;
  private readonly dataChannelLabel: string;
  private readonly peers = new Map<string, ActiveLeaderPeer>();
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
      await this.peers.get(message.bootstrapId)?.peer.setRemoteDescription(message.answer);
    } else if (message.type === 'bootstrap.ice_candidate') {
      await this.peers.get(message.bootstrapId)?.peer.addIceCandidate(message.candidate);
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
      runtime: message.runtime,
    };
    const channel = peer.createDataChannel(this.dataChannelLabel);
    this.peers.set(message.bootstrapId, { state, peer, channel });

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
      const active = this.peers.get(message.bootstrapId);
      if (!active) return;
      if (active.state.state !== 'connected') {
        // Pre-connection failure
        if (peer.connectionState === 'failed') {
          this.failPeer(message, 'Leader peer connection failed before the data channel opened');
        }
      } else {
        // Post-connection: detect disconnected/failed ICE states
        if (peer.connectionState === 'disconnected' || peer.connectionState === 'failed') {
          log.warn('Leader peer connection state changed post-connect', {
            bootstrapId: message.bootstrapId,
            state: peer.connectionState,
          });
          this.options.onPeerDisconnected?.(
            message.bootstrapId,
            `Peer connection ${peer.connectionState}`
          );
        }
      }
    });

    channel.addEventListener('open', () => {
      const active = this.peers.get(message.bootstrapId);
      if (!active || active.state.state === 'connected') return;
      active.state.state = 'connected';
      active.state.connectedAt = new Date().toISOString();
      this.options.onPeerConnected?.({ ...active.state }, active.channel);
    });
    channel.addEventListener('close', () => {
      const active = this.peers.get(message.bootstrapId);
      if (!active) return;
      if (active.state.state !== 'connected') {
        this.failPeer(message, 'Leader data channel closed before opening');
      } else {
        log.warn('Leader data channel closed post-connect', { bootstrapId: message.bootstrapId });
        this.options.onPeerDisconnected?.(message.bootstrapId, 'Data channel closed');
      }
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
      log.warn('Failed to report tray bootstrap failure', {
        error: error instanceof Error ? error.message : String(error),
      });
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

  constructor(private readonly options: FollowerTrayManagerOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.iceServers = options.iceServers;
    this.peerConnectionFactory =
      options.peerConnectionFactory ?? (() => createBrowserPeerConnection(this.iceServers));
    this.controllerIdFactory = options.controllerIdFactory ?? (() => crypto.randomUUID());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  async start(): Promise<FollowerTrayConnection> {
    this.stopped = false;
    const controllerId = this.controllerIdFactory();
    const connectingSince = Date.now();

    setFollowerTrayRuntimeStatus({
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
        setFollowerTrayRuntimeStatus({
          ...getFollowerTrayRuntimeStatus(),
          attachAttempts: attachAttempt,
          lastError: errorMsg,
        });
        throw error;
      }

      // Update status with attach attempt progress
      setFollowerTrayRuntimeStatus({
        ...getFollowerTrayRuntimeStatus(),
        attachAttempts: attachAttempt,
        lastAttachCode: attach.code,
      });

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
        setFollowerTrayRuntimeStatus({
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
        setFollowerTrayRuntimeStatus({
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
        setFollowerTrayRuntimeStatus({
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
        for (const event of poll.events) {
          if (event.type === 'bootstrap.offer') {
            await this.activePeer.peer.setRemoteDescription(event.offer);
            const answer = await this.activePeer.peer.createAnswer();
            await this.activePeer.peer.setLocalDescription(answer);
            await sendTrayFollowerAnswer({
              joinUrl: this.options.joinUrl,
              controllerId,
              bootstrapId: bootstrap.bootstrapId,
              answer: normalizeSessionDescription(
                this.activePeer.peer.localDescription ?? answer,
                'answer'
              ),
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
    peer.addEventListener('connectionstatechange', () => {
      if (!active.open) {
        // Pre-connection: handled by openError in completeBootstrap
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
      active.channel = channel;
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
      const normalized = normalizeIceCandidate(candidate);
      if (!normalized) return;
      void sendTrayFollowerIceCandidate({
        joinUrl: this.options.joinUrl,
        controllerId,
        bootstrapId,
        candidate: normalized,
        fetchImpl: this.fetchImpl,
      }).catch((error) => {
        log.warn('Failed to send follower ICE candidate', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
    return active;
  }
}

// ---------------------------------------------------------------------------
// Auto-reconnect wrapper for FollowerTrayManager
// ---------------------------------------------------------------------------

export interface FollowerAutoReconnectOptions {
  /** Base delay in ms before the first reconnect attempt. Default: 1000. */
  baseDelayMs?: number;
  /** Multiplier applied to the delay after each failed attempt. Default: 2. */
  backoffMultiplier?: number;
  /** Maximum delay between reconnect attempts in ms. Default: 30000. */
  maxDelayMs?: number;
  /** Maximum number of reconnect attempts before giving up. Default: 10. */
  maxAttempts?: number;
  /** Called when a new connection is established (initial or reconnect). */
  onConnected: (connection: FollowerTrayConnection) => void;
  /** Called when reconnection starts or progresses. */
  onReconnecting?: (attempt: number) => void;
  /** Called when reconnection fails permanently (max attempts exhausted). */
  onGaveUp?: (lastError: string) => void;
  /** Sleep implementation for testing. Default: setTimeout-based. */
  sleep?: (ms: number) => Promise<void>;
}

export interface FollowerAutoReconnectHandle {
  /** Cancel any in-progress reconnection and stop the follower. */
  cancel(): void;
  /** Whether reconnection is currently in progress. */
  readonly reconnecting: boolean;
}

/**
 * Start a FollowerTrayManager with automatic reconnection on disconnect.
 *
 * Returns a handle to cancel the reconnect loop (e.g. when user manually
 * re-joins a different tray). The `onConnected` callback fires for each
 * successful connection — including the initial one and every reconnect.
 *
 * The `onDisconnected` option on FollowerTrayManagerOptions is consumed
 * internally to trigger reconnection — do not set it yourself.
 */
export function startFollowerWithAutoReconnect(
  managerOptions: FollowerTrayManagerOptions,
  reconnectOptions: FollowerAutoReconnectOptions
): FollowerAutoReconnectHandle {
  const baseDelay = reconnectOptions.baseDelayMs ?? 1000;
  const multiplier = reconnectOptions.backoffMultiplier ?? 2;
  const maxDelay = reconnectOptions.maxDelayMs ?? 30_000;
  const maxAttempts = reconnectOptions.maxAttempts ?? 10;
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
    });
    activeManager = manager;
    return { manager, connectionPromise: manager.start() };
  };

  const reconnectLoop = async (initialReason?: string): Promise<void> => {
    if (cancelled || reconnecting) return;
    reconnecting = true;

    // Tear down old manager
    activeManager?.stop();
    activeManager = null;

    let attempt = 0;
    let delay = baseDelay;
    let lastError = initialReason ?? 'Unknown disconnect';

    while (!cancelled && attempt < maxAttempts) {
      attempt++;
      reconnectOptions.onReconnecting?.(attempt);
      setFollowerTrayRuntimeStatus({
        ...getFollowerTrayRuntimeStatus(),
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

        // Success — reset state and notify
        reconnecting = false;
        setFollowerTrayRuntimeStatus({
          ...getFollowerTrayRuntimeStatus(),
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
        // Tear down the failed manager
        manager?.stop();
        activeManager = null;
      }

      // Exponential backoff
      delay = Math.min(delay * multiplier, maxDelay);
    }

    // Gave up or cancelled
    if (!cancelled) {
      reconnecting = false;
      setFollowerTrayRuntimeStatus({
        ...getFollowerTrayRuntimeStatus(),
        state: 'error',
        error: `Reconnect failed after ${attempt} attempts: ${lastError}`,
        reconnectAttempts: attempt,
      });
      log.warn('Reconnect gave up', { attempts: attempt, lastError });
      reconnectOptions.onGaveUp?.(lastError);
    }
  };

  // Initial connection
  const { connectionPromise } = connectOnce();
  void connectionPromise
    .then((connection) => {
      if (cancelled) return;
      reconnectOptions.onConnected(connection);
    })
    .catch((error) => {
      if (cancelled) return;
      log.warn('Initial follower connection failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });

  return handle;
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

function normalizeIceCandidate(candidate: unknown): TrayIceCandidate | null {
  if (!candidate || typeof candidate !== 'object') return null;
  const value = candidate as Record<string, unknown>;
  return typeof value['candidate'] === 'string'
    ? {
        candidate: value['candidate'],
        sdpMid: typeof value['sdpMid'] === 'string' ? value['sdpMid'] : null,
        sdpMLineIndex: typeof value['sdpMLineIndex'] === 'number' ? value['sdpMLineIndex'] : null,
        usernameFragment:
          typeof value['usernameFragment'] === 'string' ? value['usernameFragment'] : null,
      }
    : null;
}

function ensureNotStopped(stopped: boolean): void {
  if (stopped) {
    throw new Error('Tray follower stopped before WebRTC bootstrap completed');
  }
}
