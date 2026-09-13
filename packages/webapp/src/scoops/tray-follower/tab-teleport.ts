import type { FollowerSyncContext } from './context.js';

/** Client-side cap; sits outside the leader router's own 45 s budget. */
const TAB_TELEPORT_CLIENT_TIMEOUT_MS = 60_000;

interface TabOpenResolver {
  resolve: (targetId: string) => void;
  reject: (err: Error) => void;
}

/** Tab open / teleport resolvers and local Target.createTarget execution. */
export class FollowerTabTeleport {
  private readonly tabOpenResolvers = new Map<string, TabOpenResolver>();

  constructor(private readonly context: FollowerSyncContext) {}

  /**
   * Open a tab on a remote runtime via the leader.
   * Resolves with the composite targetId ("{runtimeId}:{localTargetId}").
   */
  openRemoteTab(targetRuntimeId: string, url: string): Promise<string> {
    const requestId = `tab-open-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise<string>((resolve, reject) => {
      this.tabOpenResolvers.set(requestId, { resolve, reject });
      this.context.send({ type: 'tab.open', requestId, targetRuntimeId, url });
    });
  }

  /**
   * Ask the leader to teleport an existing tray tab HERE — a foreground copy
   * carrying the source tab's cookies + web storage. Resolves with the local
   * composite targetId. The leader replies on the shared `tab.opened` /
   * `tab.open.error` legs, so this reuses `tabOpenResolvers` (already drained
   * on disconnect by `rejectPending`).
   */
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

  /**
   * Execute a tab.open on the follower's local browser transport.
   * Sends tab.opened or tab.open.error back to the leader.
   */
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
      // Some CDP versions / target denial paths can return without a usable
      // targetId. Surface a meaningful error instead of forwarding "undefined"
      // and letting the leader fail later attaching to a junk id.
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
