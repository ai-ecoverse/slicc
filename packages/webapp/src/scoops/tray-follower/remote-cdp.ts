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

export class FollowerRemoteCdp {
  private readonly remoteTransports = new Map<string, RemoteCDPTransport>();

  private readonly cdpChunkBuffers = new Map<
    string,
    { chunks: string[]; received: number; totalChunks: number }
  >();

  private readonly remoteCDPSessions = new Set<string>();

  private readonly cdpEventCleanups: Array<() => void> = [];

  constructor(private readonly context: FollowerSyncContext) {}

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

  removeRemoteTransport(targetRuntimeId: string, localTargetId: string): void {
    const key = `${targetRuntimeId}:${localTargetId}`;
    const transport = this.remoteTransports.get(key);
    if (transport) {
      transport.disconnect();
      this.remoteTransports.delete(key);
    }
  }

  async executeLocalCDP(
    requestId: string,

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

  private setupEventForwarding(transport: CDPTransport, remoteSessionId: string): void {
    for (const eventName of FORWARDED_CDP_EVENTS) {
      const listener = (params: CDPPayload) => {
        if (params['sessionId'] !== remoteSessionId) return;
        if (!this.remoteCDPSessions.has(remoteSessionId)) return;

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

  cleanupEventForwarding(): void {
    for (const cleanup of this.cdpEventCleanups) cleanup();
    this.cdpEventCleanups.length = 0;
    this.remoteCDPSessions.clear();
  }

  routeCDPResponse(message: LeaderToFollowerMessage & { type: 'cdp.response' }): void {
    const assembled = reassembleCDPResponse(this.cdpChunkBuffers, message);
    if (!assembled) return;

    for (const transport of this.remoteTransports.values()) {
      transport.handleResponse(message.requestId, assembled.result, assembled.error);
    }
  }

  routeCDPEvent(message: LeaderToFollowerMessage & { type: 'cdp.event' }): void {
    const params = message.sessionId
      ? { ...message.params, sessionId: message.sessionId }
      : message.params;
    for (const transport of this.remoteTransports.values()) {
      transport.handleEvent(message.method, params);
    }
  }

  rejectPending(): void {
    this.cdpChunkBuffers.clear();
    for (const transport of this.remoteTransports.values()) transport.disconnect();
    this.remoteTransports.clear();
  }
}
