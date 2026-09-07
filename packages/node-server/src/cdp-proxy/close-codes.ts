/**
 * Application-range (4000–4999) WebSocket close codes the `/cdp` proxy sends
 * to its single client. Both MUST stay in sync with the same-named constants
 * in `packages/webapp/src/cdp/cdp-client.ts` (and their Swift twins in
 * `packages/swift-server/Sources/WebSocket/CDPProxy.swift`), because the
 * page-side `CDPClient` branches on the exact numeric code.
 */

/**
 * Sent to a CDP client that is evicted because a newer client took the single
 * proxy slot. The page-side `CDPClient` recognises it and stops
 * auto-reconnecting (otherwise two webapp tabs on one instance evict each
 * other forever). MUST stay in sync with `CDP_SUPERSEDED_CLOSE_CODE` in
 * `packages/webapp/src/cdp/cdp-client.ts`.
 */
export const CDP_SUPERSEDED_CLOSE_CODE = 4001;

/**
 * Sent to the active CDP client after the proxy's Chrome-leg WebSocket dropped
 * and was re-established (or definitively failed to come back). Chrome
 * discards every CDP session when that socket closes, so the page's cached
 * `sessionId`s are dead — but nothing else tells it. The page-side `CDPClient`
 * treats this code as "reconnect and reset session state" (unlike
 * {@link CDP_SUPERSEDED_CLOSE_CODE}, it does NOT latch superseded). MUST stay
 * in sync with `CDP_UPSTREAM_RESET_CLOSE_CODE` in
 * `packages/webapp/src/cdp/cdp-client.ts`.
 */
export const CDP_UPSTREAM_RESET_CLOSE_CODE = 4002;

/** Close reason paired with {@link CDP_UPSTREAM_RESET_CLOSE_CODE}. */
export const CDP_UPSTREAM_RESET_CLOSE_REASON = 'upstream-reset';
