import type { CDPPayload } from '@slicc/shared-ts';
import { reassembleCDPResponse, sendCDPResponse } from '@slicc/shared-ts';
import { type RemoteCDPSender, RemoteCDPTransport } from '../../cdp/remote-cdp-transport.js';
import type { CDPTransport } from '../../cdp/transport.js';
import type { LeaderToFollowerMessage } from '../tray-sync-protocol.js';
import type { FollowerSyncContext } from './context.js';

const FORWARDED_CDP_EVENTS = [
  'Page.frameNavigated',
  'Page.loadEventFired',
  'Page.domContentEventFired',
  'Network.responseReceived',
  'Network.loadingFinished',
  'Network.requestWillBeSent',
  'Runtime.executionContextCreated',
  'Runtime.executionContextDestroyed',
  'Runtime.executionContextsCleared',
] as const;

/** Remote CDP transports, local execution, and event forwarding. */
export class FollowerRemoteCdp {
  /** Active RemoteCDPTransport instances keyed by requestId prefix for response routing. */
  private readonly remoteTransports = new Map<string, RemoteCDPTransport>();
  /** Chunk buffers for reassembling chunked CDP responses from the leader. */
  private readonly cdpChunkBuffers = new Map<
    string,
    { chunks: string[]; received: number; totalChunks: number }
  >();
  /** CDP sessions initiated by remote requests (leader attached to follower tabs). */
  private readonly remoteCDPSessions = new Set<string>();
  /** Cleanup functions for CDP event listeners registered on the local transport. */
  private readonly cdpEventCleanups: Array<() => void> = [];

  constructor(private readonly context: FollowerSyncContext) {}

  /**
   * Create a RemoteCDPTransport that routes CDP commands to a remote runtime
   * via the leader data channel.
   */
  createRemoteTransport(targetRuntimeId: string, localTargetId: string): RemoteCDPTransport {
    const sender: RemoteCDPSender = {
      sendCDPRequest: (requestId, method, params, sessionId) => {
        this.context.send({
          type: 'cdp.request',
          requestId,
          targetRuntimeId,
          localTargetId,
          method,
          params,
          sessionId,
        });
      },
    };
    const transport = new RemoteCDPTransport(sender);
    this.remoteTransports.set(`${targetRuntimeId}:${localTargetId}`, transport);
    return transport;
  }

  /** Remove a remote transport when no longer needed. */
  removeRemoteTransport(targetRuntimeId: string, localTargetId: string): void {
    const key = `${targetRuntimeId}:${localTargetId}`;
    const transport = this.remoteTransports.get(key);
    if (transport) {
      transport.disconnect();
      this.remoteTransports.delete(key);
    }
  }

  /**
   * Execute a CDP command on the follower's local browser transport.
   * Sends the response back to the leader, chunking if necessary.
   *
   * When a `Target.attachToTarget` command succeeds, the resulting sessionId
   * is tracked as a remote-initiated session so that CDP events for that
   * session are forwarded to the leader.
   */
  async executeLocalCDP(
    requestId: string,
    // Unused: the wire message carries the follower-local target id for
    // symmetry, but the transport routes by sessionId/method alone.
    _localTargetId: string,
    method: string,
    params: CDPPayload | undefined,
    sessionId: string | undefined
  ): Promise<void> {
    const transport = this.context.options.browserTransport;
    if (!transport) {
      this.context.send({
        type: 'cdp.response',
        requestId,
        error: 'Follower has no browser transport',
      });
      return;
    }

    try {
      const result = await transport.send(method, params, sessionId);

      if (method === 'Target.attachToTarget' && result['sessionId']) {
        const remoteSessionId = result['sessionId'] as string;
        this.remoteCDPSessions.add(remoteSessionId);
        this.setupEventForwarding(transport, remoteSessionId);
        this.context.log.debug('Tracking remote CDP session', { remoteSessionId });
      }

      if (
        method === 'Target.detachFromTarget' &&
        sessionId &&
        this.remoteCDPSessions.has(sessionId)
      ) {
        this.remoteCDPSessions.delete(sessionId);
        this.context.log.debug('Removed remote CDP session on detach', { sessionId });
      }

      sendCDPResponse({ send: this.context.send }, requestId, result);
    } catch (err) {
      this.context.send({
        type: 'cdp.response',
        requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Register CDP event listeners on the local transport for a remote-initiated
   * session. Events matching the sessionId are forwarded to the leader.
   */
  private setupEventForwarding(transport: CDPTransport, remoteSessionId: string): void {
    for (const eventName of FORWARDED_CDP_EVENTS) {
      const listener = (params: CDPPayload) => {
        if (params['sessionId'] !== remoteSessionId) return;
        if (!this.remoteCDPSessions.has(remoteSessionId)) return;
        // Strip sessionId from forwarded params — the leader routes by
        // sessionId at the message level.
        const { sessionId: _sid, ...forwardedParams } = params;
        this.context.send({
          type: 'cdp.event',
          method: eventName,
          params: forwardedParams,
          sessionId: remoteSessionId,
        });
      };
      transport.on(eventName, listener);
      this.cdpEventCleanups.push(() => transport.off(eventName, listener));
    }
  }

  /** Remove all CDP event listeners and clear session tracking. */
  cleanupEventForwarding(): void {
    for (const cleanup of this.cdpEventCleanups) cleanup();
    this.cdpEventCleanups.length = 0;
    this.remoteCDPSessions.clear();
  }

  /**
   * Route a CDP response from the leader to the appropriate RemoteCDPTransport.
   * Handles chunked responses by reassembling before delivery.
   */
  routeCDPResponse(message: LeaderToFollowerMessage & { type: 'cdp.response' }): void {
    const assembled = reassembleCDPResponse(this.cdpChunkBuffers, message);
    if (!assembled) return;

    for (const transport of this.remoteTransports.values()) {
      transport.handleResponse(message.requestId, assembled.result, assembled.error);
    }
  }

  /** Route a leader CDP event to remote transports, restoring flattened session identity. */
  routeCDPEvent(message: LeaderToFollowerMessage & { type: 'cdp.event' }): void {
    const params = message.sessionId
      ? { ...message.params, sessionId: message.sessionId }
      : message.params;
    for (const transport of this.remoteTransports.values()) {
      transport.handleEvent(message.method, params);
    }
  }

  /**
   * Drop chunk buffers and disconnect remote transports. `RemoteCDPTransport.disconnect()`
   * rejects its own pending request/response promises.
   */
  rejectPending(): void {
    this.cdpChunkBuffers.clear();
    for (const transport of this.remoteTransports.values()) transport.disconnect();
    this.remoteTransports.clear();
  }
}
