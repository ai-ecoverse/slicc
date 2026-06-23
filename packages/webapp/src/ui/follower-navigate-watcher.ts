import { NavigationWatcher } from '../cdp/navigation-watcher.js';
import type { CDPTransport } from '../cdp/transport.js';
import { createLogger } from '../core/logger.js';
import type { LickEvent } from '../scoops/lick-manager.js';

const log = createLogger('follower-navigate-watcher');

interface ForwardSync {
  forwardLick(event: LickEvent): boolean;
}

/**
 * Page-side replacement for the kernel worker's NavigationWatcher → LickManager
 * forwarder. A no-kernel follower has no LickManager, so this watches the page's
 * CDP transport directly and forwards `navigate` licks (handoffs) to the leader
 * via `FollowerSyncManager.forwardLick`. Returns a stop function.
 */
export function startFollowerNavigateWatcher(
  transport: CDPTransport,
  getSync: () => ForwardSync | null
): () => void {
  const watcher = new NavigationWatcher(transport, (event) => {
    const body: Record<string, unknown> = {
      url: event.url,
      verb: event.verb,
      target: event.target,
    };
    if (event.instruction != null) body.instruction = event.instruction;
    if (event.branch != null) body.branch = event.branch;
    if (event.path != null) body.path = event.path;
    if (event.title != null) body.title = event.title;
    const sync = getSync();
    if (!sync) {
      log.warn('navigate lick dropped — no follower sync connected', { url: event.url });
      return;
    }
    sync.forwardLick({
      type: 'navigate',
      navigateUrl: event.url,
      targetScoop: undefined,
      timestamp: new Date().toISOString(),
      body,
    });
  });
  void watcher.start();
  return () => void watcher.stop();
}
