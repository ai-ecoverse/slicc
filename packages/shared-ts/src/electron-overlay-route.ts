/**
 * Single source of truth for the hosted Electron thin-overlay route and the
 * `role` query-param vocabulary used along that route. The same contract is
 * read by node-server (constructs the URL), cloudflare-worker (special-cases
 * the response's CSP + cache headers), and webapp (detects overlay mode from
 * `window.location.pathname`). Keeping the constants here is what stops the
 * three packages from drifting.
 */

/**
 * Path of the hosted Electron thin-overlay app. node-server mints
 * `…/electron?bridge=…` URLs against this path; cloudflare-worker omits
 * `Content-Security-Policy: frame-ancestors` on responses for this path so the
 * overlay can be framed by `file://`-embedded Electron apps; the webapp
 * classifies its runtime mode as `electron-overlay` when `location.pathname`
 * matches.
 */
export const ELECTRON_OVERLAY_APP_PATH = '/electron';

/**
 * Query-param name carrying the overlay role on the hosted launcher URL.
 * The pinned leader tab carries `role=leader`; auto-follow tabs carry
 * `role=follower`. The leader drives the `/cdp` bridge; followers stay off
 * the bridge and observe via tray sync.
 */
export const BRIDGE_ROLE_QUERY_PARAM = 'role';

/** `BRIDGE_ROLE_QUERY_PARAM` value for the bridge-driving leader tab. */
export const BRIDGE_ROLE_LEADER = 'leader';

/** `BRIDGE_ROLE_QUERY_PARAM` value for tray-syncing follower tabs. */
export const BRIDGE_ROLE_FOLLOWER = 'follower';

/** Allowed values of the overlay role query param. */
export type BridgeRole = typeof BRIDGE_ROLE_LEADER | typeof BRIDGE_ROLE_FOLLOWER;
