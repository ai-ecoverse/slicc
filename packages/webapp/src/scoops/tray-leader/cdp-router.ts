import { type CDPPayload, reassembleCDPResponse, sendCDPResponse } from '@slicc/shared-ts';
import { type RemoteCDPSender, RemoteCDPTransport } from '../../cdp/remote-cdp-transport.js';
import type { CDPTransport } from '../../cdp/transport.js';
import type { FollowerToLeaderMessage } from '../tray-sync-protocol.js';
import type { LeaderSyncContext } from './context.js';

const FOLLOWER_PREVIEW_SETTLE_MS = 150;

interface FocusTargetInfo {
  targetId?: unknown;
  type?: unknown;
  active?: unknown;
}

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
  private previewOriginalTarget: Promise<string | null> | null = null;
  private previewLastTargetId: string | null = null;
  private previewGeneration = 0;
  private previewSequence = 0;
  private previewLatestSuccessfulSequence = 0;
  private previewRequestsInFlight = 0;
  private previewRestoreTimer: ReturnType<typeof setTimeout> | null = null;

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
    params: CDPPayload | undefined,
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
      const result =
        method === 'Page.bringToFront'
          ? await this.executeFollowerBringToFront(transport, localTargetId, params, sessionId)
          : await transport.send(method, params, sessionId);
      sendCDPResponse(follower.sync, requestId, result);
    } catch (err) {
      follower.sync.send({
        type: 'cdp.response',
        requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async executeFollowerBringToFront(
    transport: CDPTransport,
    localTargetId: string,
    params: CDPPayload | undefined,
    sessionId: string | undefined
  ): Promise<CDPPayload> {
    const generation = this.previewGeneration;
    const sequence = ++this.previewSequence;
    this.previewRequestsInFlight++;
    this.cancelPreviewRestore();
    this.previewOriginalTarget ??= this.findFocusedTargetId(transport, localTargetId, sessionId);

    try {
      await this.previewOriginalTarget;
      const result = await transport.send('Page.bringToFront', params, sessionId);
      if (
        generation === this.previewGeneration &&
        sequence > this.previewLatestSuccessfulSequence
      ) {
        this.previewLatestSuccessfulSequence = sequence;
        this.previewLastTargetId = localTargetId;
      }
      return result;
    } finally {
      if (generation === this.previewGeneration) {
        this.previewRequestsInFlight--;
        if (this.previewRequestsInFlight === 0 && this.previewLastTargetId === null) {
          this.previewOriginalTarget = null;
          this.previewLatestSuccessfulSequence = 0;
        } else {
          this.schedulePreviewRestore(transport);
        }
      }
    }
  }

  /** Cancel pending follower-preview restoration without disabling future previews. */
  resetPreviewFocus(): void {
    this.cancelPreviewRestore();
    this.previewGeneration++;
    this.previewOriginalTarget = null;
    this.previewLastTargetId = null;
    this.previewLatestSuccessfulSequence = 0;
    this.previewRequestsInFlight = 0;
  }

  private cancelPreviewRestore(): void {
    if (this.previewRestoreTimer === null) return;
    clearTimeout(this.previewRestoreTimer);
    this.previewRestoreTimer = null;
  }

  private schedulePreviewRestore(transport: CDPTransport): void {
    if (this.previewRequestsInFlight !== 0 || this.previewLastTargetId === null) return;
    this.cancelPreviewRestore();
    this.previewRestoreTimer = setTimeout(() => {
      this.previewRestoreTimer = null;
      void this.restorePreviewFocus(transport);
    }, FOLLOWER_PREVIEW_SETTLE_MS);
  }

  private async restorePreviewFocus(transport: CDPTransport): Promise<void> {
    const sequence = this.previewLatestSuccessfulSequence;
    const originalTargetId = await this.previewOriginalTarget;
    const previewTargetId = this.previewLastTargetId;
    if (!originalTargetId || !previewTargetId || originalTargetId === previewTargetId) {
      this.finishPreviewBurst(sequence);
      return;
    }

    const focusedTargetId = await this.findFocusedTargetId(transport);
    if (!this.previewRestoreIsCurrent(sequence)) {
      this.schedulePreviewRestore(transport);
      return;
    }
    if (focusedTargetId !== previewTargetId) {
      this.finishPreviewBurst(sequence);
      return;
    }

    try {
      await this.bringTargetToFront(transport, originalTargetId, sequence);
    } catch (err) {
      this.context.log.debug('Follower preview focus restore skipped', {
        targetId: originalTargetId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    this.finishPreviewBurst(sequence);
  }

  private previewRestoreIsCurrent(sequence: number): boolean {
    return sequence === this.previewLatestSuccessfulSequence && this.previewRequestsInFlight === 0;
  }

  private finishPreviewBurst(sequence: number): void {
    if (!this.previewRestoreIsCurrent(sequence)) return;
    this.cancelPreviewRestore();
    this.previewOriginalTarget = null;
    this.previewLastTargetId = null;
    this.previewLatestSuccessfulSequence = 0;
  }

  private async bringTargetToFront(
    transport: CDPTransport,
    targetId: string,
    sequence: number
  ): Promise<void> {
    const attached = await transport.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    const sessionId = attached['sessionId'];
    if (typeof sessionId !== 'string') return;
    try {
      if (!this.previewRestoreIsCurrent(sequence)) return;
      await transport.send('Page.bringToFront', {}, sessionId);
    } finally {
      try {
        await transport.send('Target.detachFromTarget', { sessionId });
      } catch {
        // The target may close while focus is being restored.
      }
    }
  }

  private async findFocusedTargetId(
    transport: CDPTransport,
    reusableTargetId?: string,
    reusableSessionId?: string
  ): Promise<string | null> {
    let targetInfos: FocusTargetInfo[];
    try {
      const result = await transport.send('Target.getTargets');
      targetInfos = Array.isArray(result['targetInfos'])
        ? (result['targetInfos'] as FocusTargetInfo[])
        : [];
    } catch {
      return null;
    }

    const pages = targetInfos.filter(
      (target): target is FocusTargetInfo & { targetId: string } =>
        target.type === 'page' && typeof target.targetId === 'string'
    );
    const activeTarget = pages.find((target) => target.active === true);
    if (activeTarget) return activeTarget.targetId;

    for (const target of pages) {
      const sessionId = target.targetId === reusableTargetId ? reusableSessionId : undefined;
      if (await this.targetHasFocus(transport, target.targetId, sessionId)) {
        return target.targetId;
      }
    }
    return null;
  }

  private async targetHasFocus(
    transport: CDPTransport,
    targetId: string,
    reusableSessionId?: string
  ): Promise<boolean> {
    let sessionId = reusableSessionId;
    let detach = false;
    try {
      if (!sessionId) {
        const attached = await transport.send('Target.attachToTarget', {
          targetId,
          flatten: true,
        });
        sessionId = typeof attached['sessionId'] === 'string' ? attached['sessionId'] : undefined;
        detach = !!sessionId;
      }
      if (!sessionId) return false;
      const evaluated = await transport.send(
        'Runtime.evaluate',
        { expression: 'document.hasFocus()', returnByValue: true },
        sessionId
      );
      return (evaluated['result'] as { value?: unknown } | undefined)?.value === true;
    } catch {
      return false;
    } finally {
      if (detach && sessionId) {
        try {
          await transport.send('Target.detachFromTarget', { sessionId });
        } catch {
          // The target may disappear during the focus probe.
        }
      }
    }
  }

  /** Forward a CDP request to the follower that owns the target. */
  forwardCDPRequest(
    requestId: string,
    targetRuntimeId: string,
    localTargetId: string,
    method: string,
    params: CDPPayload | undefined,
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
    params: CDPPayload,
    sessionId?: string
  ): void {
    const followerRuntimeId = this.context.followers.runtimeIdForBootstrap(bootstrapId);
    if (!followerRuntimeId) return;

    const prefix = `${followerRuntimeId}:`;
    const eventParams = sessionId ? { ...params, sessionId } : params;
    for (const [key, transport] of this.remoteTransports) {
      if (key.startsWith(prefix)) transport.handleEvent(method, eventParams);
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
