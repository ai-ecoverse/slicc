import type { FollowerSyncContext } from './context.js';

const TAB_TELEPORT_CLIENT_TIMEOUT_MS = 60_000;

interface TabOpenResolver {
  resolve: (targetId: string) => void;
  reject: (err: Error) => void;
}

export class FollowerTabTeleport {
  private readonly tabOpenResolvers = new Map<string, TabOpenResolver>();

  constructor(private readonly context: FollowerSyncContext) {}

  openRemoteTab(targetRuntimeId: string, url: string): Promise<string> {
    const requestId = `tab-open-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise<string>((resolve, reject) => {
      this.tabOpenResolvers.set(requestId, { resolve, reject });
      this.context.send({ type: 'tab.open', requestId, targetRuntimeId, url });
    });
  }

  requestTabTeleport(sourceTargetId: string): Promise<string> {
    const requestId = `tab-teleport-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.tabOpenResolvers.delete(requestId)) return;
        reject(new Error('tab teleport timed out'));
      }, TAB_TELEPORT_CLIENT_TIMEOUT_MS);
      const settle = <T>(fn: (value: T) => void) => {
        return (value: T): void => {
          clearTimeout(timer);
          fn(value);
        };
      };
      this.tabOpenResolvers.set(requestId, {
        resolve: settle(resolve),
        reject: settle(reject),
      });
      const sent = this.context.send({
        type: 'tab.teleport.request',
        requestId,
        targetId: sourceTargetId,
      });
      if (sent === false) {
        clearTimeout(timer);
        this.tabOpenResolvers.delete(requestId);
        reject(new Error('not connected to a leader'));
      }
    });
  }

  handleOpened(requestId: string, targetId: string): void {
    const resolver = this.tabOpenResolvers.get(requestId);
    if (!resolver) return;
    this.tabOpenResolvers.delete(requestId);
    resolver.resolve(targetId);
  }

  handleOpenError(requestId: string, error: string): void {
    const resolver = this.tabOpenResolvers.get(requestId);
    if (!resolver) return;
    this.tabOpenResolvers.delete(requestId);
    resolver.reject(new Error(error));
  }

  async executeLocalTabOpen(requestId: string, url: string): Promise<void> {
    const transport = this.context.options.browserTransport;
    if (!transport) {
      this.context.send({
        type: 'tab.open.error',
        requestId,
        error: 'Follower has no browser transport',
      });
      return;
    }

    try {
      const result = await transport.send('Target.createTarget', { url, background: true });
      const targetId = result['targetId'];

      if (typeof targetId !== 'string' || targetId.length === 0) {
        this.context.send({
          type: 'tab.open.error',
          requestId,
          error: 'Target.createTarget did not return a usable targetId',
        });
        return;
      }
      this.context.send({ type: 'tab.opened', requestId, targetId });
      this.context.options.onTargetsChanged?.();
    } catch (err) {
      this.context.send({
        type: 'tab.open.error',
        requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  rejectPending(reason: string): void {
    const err = new Error(reason);
    for (const { reject } of this.tabOpenResolvers.values()) reject(err);
    this.tabOpenResolvers.clear();
  }
}
