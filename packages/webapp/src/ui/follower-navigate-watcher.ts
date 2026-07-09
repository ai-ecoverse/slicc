import { type DiscoveryEvent, NavigationWatcher } from '../cdp/navigation-watcher.js';
import type { CDPTransport } from '../cdp/transport.js';
import { createLogger } from '../core/logger.js';
import type { ProbeFetch } from '../net/well-known-probe.js';
import type { LickEvent } from '../scoops/lick-manager.js';
import { createProxiedFetch } from '../shell/proxied-fetch.js';

const log = createLogger('follower-navigate-watcher');

interface ForwardSync {
  forwardLick(event: LickEvent): boolean;
}

/**
 * Build the follower's discovery wiring for the NavigationWatcher, mirroring the
 * kernel host's `buildDiscoveryWatcherOptions` (kernel/host.ts) but forwarding
 * each hit to the leader via `FollowerSyncManager.forwardLick` instead of a
 * local `LickManager.emitEvent`. Both ARD vectors (`rel="ai-catalog"` header +
 * well-known probe) run through the shared proxied fetch so the background probe
 * inherits the CORS bypass. The leader dedups repeats by artifact identity
 * (`discoveryOrigin` + `discoveryKind` + `discoveryUrl`) when it injects the
 * forwarded lick into its own LickManager, so the fingerprint survives the
 * tray round-trip.
 */
function buildFollowerDiscoveryOptions(getSync: () => ForwardSync | null): {
  onDiscovery: (event: DiscoveryEvent) => void;
  probeFetch: ProbeFetch;
  isDiscoveryEnabled: () => boolean;
} {
  const proxiedFetch = createProxiedFetch();
  // Adapt the `SecureFetch` result shape to the pure probe's `ProbeResponse`.
  // The probe's AbortSignal is honored via a race so a hung request still
  // resolves within the probe timeout (SecureFetch ignores `signal`).
  const probeFetch: ProbeFetch = async (url, init) => {
    const doFetch = proxiedFetch(url, { method: init?.method ?? 'GET' });
    const signal = init?.signal;
    const res = signal
      ? await Promise.race([
          doFetch,
          new Promise<never>((_resolve, reject) => {
            if (signal.aborted) {
              reject(new Error('aborted'));
              return;
            }
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          }),
        ])
      : await doFetch;
    const headers = res.headers as Record<string, string> | undefined;
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      headers: {
        get(name: string): string | null {
          if (!headers) return null;
          // SecureFetch returns lowercased header keys (fetch Headers), but
          // fall back to the raw name defensively.
          return headers[name.toLowerCase()] ?? headers[name] ?? null;
        },
      },
    };
  };

  return {
    onDiscovery: (event: DiscoveryEvent) => {
      const sync = getSync();
      if (!sync) {
        log.warn('discovery lick dropped — no follower sync connected', { url: event.url });
        return;
      }
      sync.forwardLick({
        type: 'discovery',
        targetScoop: undefined,
        timestamp: new Date().toISOString(),
        discoveryOrigin: event.origin,
        discoveryKind: event.kind,
        discoveryUrl: event.url,
        body: {
          origin: event.origin,
          kind: event.kind,
          url: event.url,
          targetId: event.targetId,
        },
      });
    },
    probeFetch,
    // TODO(discovery-settings): replace with the user setting getter once the
    // settings task lands. Defaults to enabled so discovery is live now.
    isDiscoveryEnabled: () => true,
  };
}

/**
 * Page-side replacement for the kernel worker's NavigationWatcher → LickManager
 * forwarder. A no-kernel follower has no LickManager, so this watches the page's
 * CDP transport directly and forwards `navigate` licks (handoffs) AND
 * `discovery` licks (ARD artifacts) to the leader via
 * `FollowerSyncManager.forwardLick`. Returns a stop function.
 */
export function startFollowerNavigateWatcher(
  transport: CDPTransport,
  getSync: () => ForwardSync | null
): () => void {
  const watcher = new NavigationWatcher(
    transport,
    (event) => {
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
    },
    buildFollowerDiscoveryOptions(getSync)
  );
  void watcher.start();
  return () => void watcher.stop();
}
