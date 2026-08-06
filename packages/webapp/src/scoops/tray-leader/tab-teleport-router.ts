/**
 * Leader side of "teleport that tab to me": a follower names a tray target it
 * can see in its tab overview, and the leader drives the state-carrying open
 * back onto that same follower.
 *
 * The destination is ALWAYS the requesting follower, resolved from the channel
 * the request arrived on — never from the payload — so one follower cannot
 * push tabs into another's browser. Replies ride the existing
 * `tab.opened` / `tab.open.error` legs.
 */

import type { BrowserAPI } from '../../cdp/browser-api.js';
import type { FollowerToLeaderMessage, TrayTargetEntry } from '../tray-sync-protocol.js';
import type { LeaderSyncContext } from './context.js';

/** Cap on one teleport; the primitive's own timeout is shorter (30 s). */
const TAB_TELEPORT_REQUEST_TIMEOUT_MS = 45_000;

export interface TabTeleportRouterOptions {
  getTargetEntries: () => TrayTargetEntry[];
  /** Injected for tests; production passes the real primitive. */
  teleportTab?: typeof import('../../shell/supplemental-commands/playwright/tab-teleport.js').teleportTabOneWay;
}

interface InFlight {
  bootstrapId: string;
  settled: boolean;
}

export class TabTeleportRouter {
  private readonly inFlight = new Map<string, InFlight>();

  constructor(
    private readonly context: LeaderSyncContext,
    private readonly options: TabTeleportRouterOptions
  ) {
    context.followers.onFollowerRemoved({
      afterRegistryCleanup: (bootstrapId) => this.abandonForFollower(bootstrapId),
    });
  }

  async handleTeleportRequest(
    bootstrapId: string,
    message: FollowerToLeaderMessage & { type: 'tab.teleport.request' }
  ): Promise<void> {
    const { requestId, targetId } = message;
    this.context.log.info('Follower requested a tab teleport', { bootstrapId, targetId });
    this.inFlight.set(requestId, { bootstrapId, settled: false });

    const timer = setTimeout(
      () => this.fail(requestId, 'tab teleport timed out'),
      TAB_TELEPORT_REQUEST_TIMEOUT_MS
    );
    try {
      const runtimeId = this.context.followers.runtimeIdForBootstrap(bootstrapId);
      if (!runtimeId) {
        this.fail(requestId, 'requesting follower has not advertised a runtime yet');
        return;
      }
      const source = this.options.getTargetEntries().find((entry) => entry.targetId === targetId);
      if (!source) {
        this.fail(requestId, `source tab ${targetId} is not in the tray registry`);
        return;
      }
      const browser = this.context.options.browserAPI;
      if (!browser) {
        this.fail(requestId, 'leader has no BrowserAPI to drive the teleport');
        return;
      }
      const teleport = this.options.teleportTab ?? (await loadTeleportTab());
      const result = await teleport(browser as BrowserAPI, {
        sourceTargetId: targetId,
        destination: { kind: 'runtime', runtimeId },
      });
      this.succeed(requestId, result.targetId, result.degraded);
    } catch (err) {
      this.fail(requestId, err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
    }
  }

  private succeed(requestId: string, targetId: string, degraded: string): void {
    const entry = this.inFlight.get(requestId);
    if (!entry || entry.settled) return;
    entry.settled = true;
    this.inFlight.delete(requestId);
    this.context.log.info('Tab teleport to follower completed', { requestId, targetId, degraded });
    this.context.followers.followers
      .get(entry.bootstrapId)
      ?.sync.send({ type: 'tab.opened', requestId, targetId });
  }

  private fail(requestId: string, error: string): void {
    const entry = this.inFlight.get(requestId);
    if (!entry || entry.settled) return;
    entry.settled = true;
    this.inFlight.delete(requestId);
    this.context.log.warn('Tab teleport to follower failed', { requestId, error });
    this.context.followers.followers
      .get(entry.bootstrapId)
      ?.sync.send({ type: 'tab.open.error', requestId, error });
  }

  /** A disconnected requester can no longer receive a reply — drop its entries. */
  private abandonForFollower(bootstrapId: string): void {
    for (const [requestId, entry] of [...this.inFlight]) {
      if (entry.bootstrapId !== bootstrapId) continue;
      entry.settled = true;
      this.inFlight.delete(requestId);
      this.context.log.info('Dropped in-flight tab teleport for departed follower', {
        requestId,
        bootstrapId,
      });
    }
  }
}

async function loadTeleportTab(): Promise<
  typeof import('../../shell/supplemental-commands/playwright/tab-teleport.js').teleportTabOneWay
> {
  const mod = await import('../../shell/supplemental-commands/playwright/tab-teleport.js');
  return mod.teleportTabOneWay;
}
