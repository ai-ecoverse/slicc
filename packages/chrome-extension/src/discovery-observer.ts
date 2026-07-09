/**
 * Extension-float discovery observer.
 *
 * Extension parity for the `discovery` lick that the CLI / standalone float
 * derives from CDP (`NavigationWatcher` + the well-known probe). The service
 * worker can't attach `chrome.debugger` to every tab just to read `Link`
 * headers, so it observes main-frame document responses via
 * `chrome.webRequest.onHeadersReceived` and probes each origin's well-known
 * discovery paths with its own `fetch` (the manifest's `host_permissions:
 * <all_urls>` lets the SW read cross-origin bodies that a page `fetch` could
 * not).
 *
 * Two vectors, both silent (no OS notification — unlike a handoff):
 *  1. A bare `rel="ai-catalog"` RFC 8288 `Link` header on the response.
 *  2. A throttled per-origin probe of `/.well-known/ai-catalog.json` and
 *     `/llms.txt`.
 *
 * Pure logic with injected dependencies (`fetchImpl`, `emit`) so it is unit-
 * testable without a real chrome runtime or network. `service-worker.ts` wires
 * it to the global `fetch` and `postDiscoveryToWelcomedLeaderPorts`.
 */

import type { DiscoveryKind } from '@slicc/shared-ts';
import {
  discoveryFingerprint,
  extractCatalogFromWebRequest,
} from '../../webapp/src/net/discovery-link.js';
import { type ProbeFetch, probeWellKnown } from '../../webapp/src/net/well-known-probe.js';

/** A discovery artifact the observer surfaces, minus the bridge envelope wrap. */
export interface ObservedDiscovery {
  discoveryOrigin: string;
  discoveryKind: DiscoveryKind;
  discoveryUrl: string;
  /** URL of the main-frame document whose response triggered the discovery. */
  url: string;
}

/** Minimal shape of a `chrome.webRequest.onHeadersReceived` detail. */
export interface DiscoveryHeadersDetail {
  url: string;
  responseHeaders?: Array<{ name: string; value?: string }>;
}

export interface DiscoveryObserverDeps {
  /** Injected fetch (the SW's global `fetch`; a mock in tests). */
  fetchImpl: ProbeFetch;
  /**
   * Sink for a newly-surfaced discovery artifact. Returns the number of leader
   * Ports the artifact was actually delivered to; the observer records the
   * dedup fingerprint only when this is `>= 1` (see {@link forward}).
   */
  emit: (discovery: ObservedDiscovery) => number;
  /** Per-request probe timeout in ms. Defaults to the probe's own default. */
  probeTimeoutMs?: number;
  /**
   * Gate consulted per response so the user setting can enable/disable
   * discovery live. When it returns `false` BOTH the header extractor and the
   * well-known probe are skipped. Defaults to always-enabled.
   */
  isEnabled?: () => boolean;
}

export interface DiscoveryObserver {
  /** Handle one `onHeadersReceived` event (header match + throttled probe). */
  onHeaders: (detail: DiscoveryHeadersDetail) => void;
}

/**
 * Build a discovery observer.
 *
 * Dedup is keyed on the artifact identity (`discoveryFingerprint`), not the
 * page URL, so a site that advertises the same `ai-catalog` rel on every page
 * (or the probe re-checking the same origin) surfaces the artifact once per SW
 * lifetime. Probes are throttled to one per origin per SW lifetime. Both sets
 * are in-memory; MV3 eviction resets them, an accepted limitation matching the
 * handoff observer's `notifiedHandoffFingerprints` design.
 */
export function createDiscoveryObserver(deps: DiscoveryObserverDeps): DiscoveryObserver {
  const seenFingerprints = new Set<string>();
  const probedOrigins = new Set<string>();

  const forward = (
    origin: string,
    kind: DiscoveryKind,
    artifactUrl: string,
    pageUrl: string
  ): void => {
    const fingerprint = discoveryFingerprint({ origin, kind, url: artifactUrl });
    if (seenFingerprints.has(fingerprint)) return;
    // Record the fingerprint ONLY when the artifact actually reached a leader
    // Port. On MV3 cold boot / browser-restore the main-frame response can be
    // observed before any leader bridge Port is welcomed, so the emit reaches 0
    // recipients — recording the fingerprint then would permanently suppress the
    // origin and the cone would never learn about it. Re-delivery on a later
    // navigation (once a Port exists) is the fail-safe.
    const delivered = deps.emit({
      discoveryOrigin: origin,
      discoveryKind: kind,
      discoveryUrl: artifactUrl,
      url: pageUrl,
    });
    if (delivered >= 1) seenFingerprints.add(fingerprint);
  };

  const probeOrigin = async (origin: string, pageUrl: string): Promise<void> => {
    if (probedOrigins.has(origin)) return;
    probedOrigins.add(origin);
    try {
      const matches = await probeWellKnown(origin, deps.fetchImpl, {
        timeoutMs: deps.probeTimeoutMs,
      });
      for (const match of matches) forward(origin, match.kind, match.url, pageUrl);
    } catch {
      // Best-effort: probing is silent and never surfaces its own failures.
    }
  };

  const isEnabled = deps.isEnabled ?? ((): boolean => true);

  const onHeaders = (detail: DiscoveryHeadersDetail): void => {
    if (!isEnabled()) return;
    let url: URL;
    try {
      url = new URL(detail.url);
    } catch {
      return;
    }
    // Only probe real web origins — chrome://, chrome-extension://, file://,
    // etc. never publish discovery artifacts and would waste a fetch.
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    const origin = url.origin;

    const { match } = extractCatalogFromWebRequest(detail.responseHeaders, detail.url);
    if (match) forward(origin, match.kind, match.url, detail.url);

    // Fire-and-forget: the probe is throttled + self-deduping and must never
    // block the webRequest listener.
    void probeOrigin(origin, detail.url);
  };

  return { onHeaders };
}
