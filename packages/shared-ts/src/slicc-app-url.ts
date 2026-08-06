/**
 * Recognize URLs that are SLICC's own app shell rather than a page the user
 * is browsing.
 *
 * Two independent reasons these must be excluded from the tray's tab list and
 * from teleport:
 *
 *  1. **Capability leak.** A float's own URL carries `bridgeToken` — the token
 *     that authorizes driving its local CDP bridge. Teleporting that tab
 *     copies the token into another machine's browser (and its history).
 *     `tray=` likewise carries the join URL, which is itself a capability.
 *  2. **Nonsense destination.** The app shell is the thing you are looking at,
 *     not something to open a second copy of; on the same machine a copy
 *     would boot a second UI against the same bridge.
 *
 * Deliberately narrow on the hosted origins: `sliccy.ai/docs/...` is an
 * ordinary page a user may well want to move, so only app-shell paths match.
 * The Swift mirror of this rule is `BrowserTargets.isSliccAppPage`.
 */

import { SLICC_HOSTED_ORIGIN, SLICC_STAGING_HUB_ORIGIN } from './bridge-protocol.js';

/**
 * Params that CARRY a capability: the value is the secret (a bridge token, a
 * bridge endpoint, a join URL). Presence alone is disqualifying regardless of
 * origin, because a float can be served from any origin (local wrangler, a
 * preview, a staging deploy) and any value here is one worth not copying.
 */
const CAPABILITY_PARAMS = ['bridgeToken', 'bridge', 'tray'] as const;

/**
 * Params that are SLICC *mode flags* rather than capabilities. The app reads
 * these as exactly `1` (`ui/runtime-mode.ts`), so match that and nothing more:
 * an ordinary page carrying `?connect=oauth2` is somebody's OAuth URL, not a
 * SLICC shell, and hiding it would block a tab the user does want to move.
 */
const MODE_FLAG_PARAMS = ['cherry', 'connect'] as const;

/** Path prefixes that serve the app shell on a SLICC-hosting origin. */
const APP_SHELL_PREFIXES = ['/join/', '/tray/'] as const;

/** Exact app-shell paths (after normalization). */
const APP_SHELL_PATHS = ['', '/', '/cloud', '/connect'] as const;

export interface SliccAppUrlOptions {
  /**
   * Extra origins known to serve the SLICC UI — typically the calling float's
   * own `location.origin`, which in development is a local wrangler
   * (`http://localhost:8787`) rather than a hosted origin.
   */
  selfOrigins?: readonly string[];
}

/** `/path` with a trailing slash and an explicit `index.html` removed. */
function normalizePath(pathname: string): string {
  const withoutIndex = pathname.replace(/\/index\.html$/, '/');
  return withoutIndex.length > 1 ? withoutIndex.replace(/\/$/, '') : withoutIndex;
}

/** True when this URL is SLICC's own UI (and so must never be teleported). */
export function isSliccAppUrl(rawUrl: string, options: SliccAppUrlOptions = {}): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    // `about:blank`, `chrome://…` and other non-URLs are not app shells; the
    // teleport path rejects unusable URLs on its own.
    return false;
  }

  // A capability-bearing URL is disqualified wherever it is served from.
  for (const param of CAPABILITY_PARAMS) {
    if (url.searchParams.has(param)) return true;
  }
  for (const flag of MODE_FLAG_PARAMS) {
    if (url.searchParams.get(flag) === '1') return true;
  }

  const origins = new Set<string>([
    SLICC_HOSTED_ORIGIN,
    SLICC_STAGING_HUB_ORIGIN,
    ...(options.selfOrigins ?? []),
  ]);
  if (!origins.has(url.origin)) return false;

  const path = normalizePath(url.pathname);
  if ((APP_SHELL_PATHS as readonly string[]).includes(path)) return true;
  return APP_SHELL_PREFIXES.some((prefix) => `${path}/`.startsWith(prefix));
}
