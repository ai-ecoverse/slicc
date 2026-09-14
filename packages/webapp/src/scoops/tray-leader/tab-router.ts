import type { TrayTargetEntry } from '../tray-sync-protocol.js';
import type { LeaderSyncContext } from './context.js';

export interface PendingTabOpenRoute {
  requesterBootstrapId: string;

  targetBootstrapId: string;

  requestId: string;
}

export interface TabRouterOptions {
  getTargetEntries: () => TrayTargetEntry[];
  isCherryTarget: (target: TrayTargetEntry) => boolean;
}

export class TabRouter {
  private readonly pendingTabOpenRoutes = new Map<string, PendingTabOpenRoute>();

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

  canRuntimeOpenTab(targetRuntimeId: string): boolean {
    const entries = this.options
      .getTargetEntries()
      .filter((entry) => entry.runtimeId === targetRuntimeId);
    if (entries.length === 0) return true;
    return entries.some((entry) => !this.options.isCherryTarget(entry));
  }

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
