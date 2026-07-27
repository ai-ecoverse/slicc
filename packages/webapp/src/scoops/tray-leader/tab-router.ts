import type { TrayTargetEntry } from '../tray-sync-protocol.js';
import type { LeaderSyncContext } from './context.js';

/** Tracks a tab.open request being routed through the leader. */
export interface PendingTabOpenRoute {
  /** bootstrapId of the follower that originated the request (or '__leader__') */
  requesterBootstrapId: string;
  /** bootstrapId of the follower opening the tab. */
  targetBootstrapId: string;
  /** The original requestId from the requester. */
  requestId: string;
}

export interface TabRouterOptions {
  getTargetEntries: () => TrayTargetEntry[];
  isCherryTarget: (target: TrayTargetEntry) => boolean;
}

export class TabRouter {
  /** Maps requestId to routing info for tab.open requests in flight through the leader. */
  private readonly pendingTabOpenRoutes = new Map<string, PendingTabOpenRoute>();
  /** Resolvers for leader-originated tab.open requests. */
  private readonly tabOpenResolvers = new Map<
    string,
    { resolve: (targetId: string) => void; reject: (err: Error) => void }
  >();

  constructor(
    private readonly context: LeaderSyncContext,
    private readonly options: TabRouterOptions
  ) {
    context.followers.onFollowerRemoved({
      afterRegistryCleanup: (bootstrapId) => this.rejectPendingForFollower(bootstrapId),
    });
  }

  /** Whether a runtime can honor a generic tab.open request. */
  canRuntimeOpenTab(targetRuntimeId: string): boolean {
    const entries = this.options
      .getTargetEntries()
      .filter((entry) => entry.runtimeId === targetRuntimeId);
    if (entries.length === 0) return true;
    return entries.some((entry) => !this.options.isCherryTarget(entry));
  }

  /** Open a tab on a remote runtime from the leader's own code. */
  openRemoteTab(targetRuntimeId: string, url: string): Promise<string> {
    const targetBootstrapId = this.context.followers.runtimeToBootstrap.get(targetRuntimeId);
    const targetFollower = targetBootstrapId
      ? this.context.followers.followers.get(targetBootstrapId)
      : undefined;
    if (!targetBootstrapId || !targetFollower) {
      return Promise.reject(new Error(`Target runtime "${targetRuntimeId}" not connected`));
    }
    if (!this.canRuntimeOpenTab(targetRuntimeId)) {
      return Promise.reject(
        new Error(`Target runtime "${targetRuntimeId}" is a cherry host that cannot open tabs`)
      );
    }

    const requestId = `tab-open-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise<string>((resolve, reject) => {
      this.tabOpenResolvers.set(requestId, { resolve, reject });
      this.pendingTabOpenRoutes.set(requestId, {
        requesterBootstrapId: '__leader__',
        targetBootstrapId,
        requestId,
      });
      targetFollower.sync.send({ type: 'tab.open', requestId, url });
    });
  }

  /** Execute a tab.open on the leader's own browser transport. */
  async executeLocalTabOpen(
    requestId: string,
    url: string,
    requesterBootstrapId: string
  ): Promise<void> {
    const follower = this.context.followers.followers.get(requesterBootstrapId);
    if (!follower) return;

    const transport = this.context.options.browserTransport;
    if (!transport) {
      follower.sync.send({
        type: 'tab.open.error',
        requestId,
        error: 'Leader has no browser transport',
      });
      return;
    }

    try {
      const result = await transport.send('Target.createTarget', { url, background: true });
      const targetId = result['targetId'] as string;
      follower.sync.send({ type: 'tab.opened', requestId, targetId: `leader:${targetId}` });
    } catch (err) {
      follower.sync.send({
        type: 'tab.open.error',
        requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Forward a tab.open request from one follower to another. */
  forwardTabOpen(
    requestId: string,
    targetRuntimeId: string,
    url: string,
    requesterBootstrapId: string
  ): void {
    const targetBootstrapId = this.context.followers.runtimeToBootstrap.get(targetRuntimeId);
    const targetFollower = targetBootstrapId
      ? this.context.followers.followers.get(targetBootstrapId)
      : undefined;
    const requester = this.context.followers.followers.get(requesterBootstrapId);

    if (!targetBootstrapId || !targetFollower) {
      requester?.sync.send({
        type: 'tab.open.error',
        requestId,
        error: `Target runtime "${targetRuntimeId}" not connected`,
      });
      return;
    }
    if (!this.canRuntimeOpenTab(targetRuntimeId)) {
      requester?.sync.send({
        type: 'tab.open.error',
        requestId,
        error: `Target runtime "${targetRuntimeId}" is a cherry host that cannot open tabs`,
      });
      return;
    }

    this.pendingTabOpenRoutes.set(requestId, {
      requesterBootstrapId,
      targetBootstrapId,
      requestId,
    });
    targetFollower.sync.send({ type: 'tab.open', requestId, url });
  }

  /** Handle a tab.opened response from a follower. */
  handleTabOpenResponse(requestId: string, targetId: string): void {
    const route = this.pendingTabOpenRoutes.get(requestId);
    if (!route) return;
    this.pendingTabOpenRoutes.delete(requestId);

    if (route.requesterBootstrapId === '__leader__') {
      const resolver = this.tabOpenResolvers.get(requestId);
      if (resolver) {
        this.tabOpenResolvers.delete(requestId);
        resolver.resolve(targetId);
      }
      return;
    }
    this.context.followers.followers
      .get(route.requesterBootstrapId)
      ?.sync.send({ type: 'tab.opened', requestId, targetId });
  }

  /** Handle a tab.open.error response from a follower. */
  handleTabOpenError(requestId: string, error: string): void {
    const route = this.pendingTabOpenRoutes.get(requestId);
    if (!route) return;
    this.pendingTabOpenRoutes.delete(requestId);

    if (route.requesterBootstrapId === '__leader__') {
      const resolver = this.tabOpenResolvers.get(requestId);
      if (resolver) {
        this.tabOpenResolvers.delete(requestId);
        resolver.reject(new Error(error));
      }
      return;
    }
    this.context.followers.followers
      .get(route.requesterBootstrapId)
      ?.sync.send({ type: 'tab.open.error', requestId, error });
  }

  private rejectPendingForFollower(bootstrapId: string): void {
    for (const [requestId, route] of this.pendingTabOpenRoutes) {
      if (route.targetBootstrapId !== bootstrapId && route.requesterBootstrapId !== bootstrapId) {
        continue;
      }
      this.pendingTabOpenRoutes.delete(requestId);
      const resolver = this.tabOpenResolvers.get(requestId);
      if (!resolver) continue;
      this.tabOpenResolvers.delete(requestId);
      resolver.reject(new Error('follower disconnected before the tab opened'));
    }
  }
}
