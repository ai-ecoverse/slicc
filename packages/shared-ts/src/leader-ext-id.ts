/**
 * URL query parameter the service worker appends to the pinned leader-tab
 * URL carrying the extension id. The leader page reads it to open the
 * `chrome.runtime.connect(<id>, { name: EXTENSION_BRIDGE_PORT_NAME })` Port
 * (see `extension-bridge-protocol.ts`) — `chrome.runtime.id` is undefined on
 * an externally_connectable page, so the id must be passed in out of band.
 *
 * Deliberately its own one-export module (#2276 slice E round-1 review)
 * rather than living inside `extension-bridge-protocol.ts`: two first-load
 * page files (`ui/boot/setup-standalone-prelude.ts`,
 * `ui/llm-proxy-sw-config.ts`) import only this constant, and pulling in the
 * whole 240-line envelope-type module for one string constant unnecessarily
 * widens whatever a bundler decides is reachable from the eager page graph.
 */
export const LEADER_EXT_ID_QUERY_NAME = 'ext';
