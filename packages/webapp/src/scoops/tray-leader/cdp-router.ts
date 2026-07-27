import { type RemoteCDPSender, RemoteCDPTransport } from '../../cdp/remote-cdp-transport.js';
import type { CDPTransport } from '../../cdp/transport.js';
import type { FollowerToLeaderMessage } from '../tray-sync-protocol.js';
import { reassembleCDPResponse, sendCDPResponse } from '../tray-sync-protocol.js';
import type { LeaderSyncContext } from './context.js';

/** Tracks a CDP request being routed through the leader. */
export interface PendingCDPRoute {
  /** bootstrapId of the follower that originated the request */
  requesterBootstrapId: string;
  /** The original requestId from the requester */
  requestId: string;
}

export interface CDPRouterOptions {
  getBridgeTransport: (connId: string) => CDPTransport | undefined;
}

export class CDPRouter {
  /** Maps requestId to routing info for CDP requests in flight through the leader. */
  private readonly pendingCDPRoutes = new Map<string, PendingCDPRoute>();
  /** Chunk buffers for reassembling chunked CDP responses from followers. */
  private readonly cdpChunkBuffers = new Map<
    string,
    { chunks: string[]; received: number; totalChunks: number }
  >();
  /** Active transports for the leader's BrowserAPI, keyed by runtimeId:localTargetId. */
  private readonly remoteTransports = new Map<string, RemoteCDPTransport>();

  constructor(
    private readonly context: LeaderSyncContext,
    private readonly options: CDPRouterOptions
  ) {
    context.followers.onFollowerRemoved({
      removeRuntime: (_bootstrapId, runtimeId) => this.cleanupRemoteTransports(runtimeId),
    });
  }

  /** Route an inbound follower CDP request locally or to the target follower. */
  handleCDPRequest(
    bootstrapId: string,
    message: FollowerToLeaderMessage & { type: 'cdp.request' }
  ): void {
    const { requestId, targetRuntimeId, localTargetId, method, params, sessionId } = message;
    if (targetRuntimeId === 'leader') {
      void this.executeLocalCDP(requestId, localTargetId, method, params, sessionId, bootstrapId);
      return;
    }
    this.forwardCDPRequest(
      requestId,
      targetRuntimeId,
      localTargetId,
      method,
      params,
      sessionId,
      bootstrapId
    );
  }

  /** Execute a CDP command on the leader's own browser transport. */
  async executeLocalCDP(
    requestId: string,
    localTargetId: string,
    method: string,
    params: Record<string, unknown> | undefined,
    sessionId: string | undefined,
    requesterBootstrapId: string
  ): Promise<void> {
    const follower = this.context.followers.followers.get(requesterBootstrapId);
    if (!follower) return;

    const transport = this.context.options.browserTransport;
    if (!transport) {
      follower.sync.send({
        type: 'cdp.response',
        requestId,
        error: 'Leader has no browser transport',
      });
      return;
    }

    try {
      const result = await transport.send(method, params, sessionId);
      sendCDPResponse(follower.sync, requestId, result);
    } catch (err) {
      follower.sync.send({
        type: 'cdp.response',
        requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Forward a CDP request to the follower that owns the target. */
  forwardCDPRequest(
    requestId: string,
    targetRuntimeId: string,
    localTargetId: string,
    method: string,
    params: Record<string, unknown> | undefined,
    sessionId: string | undefined,
    requesterBootstrapId: string
  ): void {
    const targetBootstrapId = this.context.followers.runtimeToBootstrap.get(targetRuntimeId);
    const targetFollower = targetBootstrapId
      ? this.context.followers.followers.get(targetBootstrapId)
      : undefined;
    const requester = this.context.followers.followers.get(requesterBootstrapId);

    if (!targetFollower) {
      if (requester) {
        requester.sync.send({
          type: 'cdp.response',
          requestId,
          error: `Target runtime "${targetRuntimeId}" not connected`,
        });
      }
      return;
    }

    this.pendingCDPRoutes.set(requestId, { requesterBootstrapId, requestId });
    targetFollower.sync.send({
      type: 'cdp.request',
      requestId,
      localTargetId,
      method,
      params,
      sessionId,
    });
  }

  /** Reassemble and route a CDP response from a follower. */
  handleCDPResponse(message: FollowerToLeaderMessage & { type: 'cdp.response' }): void {
    const { requestId } = message;
    const route = this.pendingCDPRoutes.get(requestId);
    if (!route) return;

    const assembled = reassembleCDPResponse(this.cdpChunkBuffers, message);
    if (!assembled) return;

    this.pendingCDPRoutes.delete(requestId);
    if (route.requesterBootstrapId === '__leader__') {
      for (const transport of this.remoteTransports.values()) {
        transport.handleResponse(requestId, assembled.result, assembled.error);
      }
      return;
    }

    const requester = this.context.followers.followers.get(route.requesterBootstrapId);
    if (requester) {
      sendCDPResponse(requester.sync, requestId, assembled.result, assembled.error);
    }
  }

  /** Deliver a follower CDP event to transports for that follower runtime. */
  handleCDPEvent(
    bootstrapId: string,
    method: string,
    params: Record<string, unknown>,
    sessionId?: string
  ): void {
    const followerRuntimeId = this.context.followers.runtimeIdForBootstrap(bootstrapId);
    if (!followerRuntimeId) return;

    const prefix = `${followerRuntimeId}:`;
    for (const [key, transport] of this.remoteTransports) {
      if (key.startsWith(prefix)) transport.handleEvent(method, params);
    }
  }

  /** Create a transport for a follower or bridge-connected preview target. */
  createRemoteTransport(targetRuntimeId: string, localTargetId: string): CDPTransport {
    if (targetRuntimeId === 'preview') {
      const colonIdx = localTargetId.indexOf(':');
      if (colonIdx === -1) {
        throw new Error(
          `Invalid preview localTargetId format: expected "<token>:<connId>", got "${localTargetId}"`
        );
      }
      const connId = localTargetId.slice(colonIdx + 1);
      const transport = this.options.getBridgeTransport(connId);
      if (!transport) throw new Error(`Preview bridge connection "${connId}" not found`);
      return transport;
    }

    const key = `${targetRuntimeId}:${localTargetId}`;
    const sender: RemoteCDPSender = {
      sendCDPRequest: (requestId, method, params, sessionId) => {
        const targetBootstrapId = this.context.followers.runtimeToBootstrap.get(targetRuntimeId);
        const targetFollower = targetBootstrapId
          ? this.context.followers.followers.get(targetBootstrapId)
          : undefined;
        if (!targetFollower) {
          this.remoteTransports
            .get(key)
            ?.handleResponse(
              requestId,
              undefined,
              `Target runtime "${targetRuntimeId}" not connected`
            );
          return;
        }
        this.pendingCDPRoutes.set(requestId, {
          requesterBootstrapId: '__leader__',
          requestId,
        });
        targetFollower.sync.send({
          type: 'cdp.request',
          requestId,
          localTargetId,
          method,
          params,
          sessionId,
        });
      },
    };
    const transport = new RemoteCDPTransport(sender);
    this.remoteTransports.set(key, transport);
    return transport;
  }

  /** Remove a remote transport created for the leader's BrowserAPI. */
  removeRemoteTransport(targetRuntimeId: string, localTargetId: string): void {
    const key = `${targetRuntimeId}:${localTargetId}`;
    const transport = this.remoteTransports.get(key);
    if (transport) {
      transport.disconnect();
      this.remoteTransports.delete(key);
    }
  }

  /** Clean up transports for a disconnected runtime and notify the page bridge. */
  cleanupRemoteTransports(runtimeId: string): void {
    const prefix = `${runtimeId}:`;
    for (const key of [...this.remoteTransports.keys()]) {
      if (key.startsWith(prefix)) {
        this.remoteTransports.get(key)?.disconnect();
        this.remoteTransports.delete(key);
        this.context.log.debug('Cleaned up stale remote transport', { key });
      }
    }
    try {
      this.context.options.onRemoteTransportsCleaned?.(runtimeId);
    } catch (err) {
      this.context.log.warn('onRemoteTransportsCleaned handler threw', {
        runtimeId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Clean transports whose runtime mappings disappeared before a new advertisement. */
  cleanupOrphanedRemoteTransports(currentRuntimeId: string): void {
    for (const key of [...this.remoteTransports.keys()]) {
      const runtimeId = key.substring(0, key.indexOf(':'));
      if (
        runtimeId !== 'leader' &&
        !this.context.followers.runtimeToBootstrap.has(runtimeId) &&
        runtimeId !== currentRuntimeId
      ) {
        this.remoteTransports.get(key)?.disconnect();
        this.remoteTransports.delete(key);
        this.context.log.debug('Cleaned up orphaned remote transport on advertise', { key });
      }
    }
  }
}
