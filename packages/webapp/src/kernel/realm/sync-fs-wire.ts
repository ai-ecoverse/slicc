/**
 * Single source of truth for the synchronous-bridge wire contract — both the
 * `fs` channel (`/__slicc/fs-sync/*`) and the `exec` channel
 * (`/__slicc/exec-sync`) that backs `child_process.execSync` & friends.
 *
 * The bridge spans three bundles that can't share a runtime import cheaply —
 * the realm worker (`sync-fs-xhr-bridge.ts` / `sync-exec-xhr-bridge.ts`), the
 * kernel-worker responder (`sync-fs-responder.ts`), and the Service Worker
 * (`ui/sync-fs-sw-handler.ts` bundled into `llm-proxy-sw`). This module is
 * **dependency-free** (only string constants + wire types) so every side can
 * import it without dragging logic across bundle boundaries, and a rename can't
 * silently desync the two ends (which would fail at runtime, not compile time).
 */

import type { SyncExecRequest } from './sync-exec-dispatch.js';
import type { SyncFsRequest, SyncFsResult } from './sync-fs-dispatch.js';

/**
 * The two security-critical strings in this bridge, branded so the compiler
 * keeps them distinct from each other and from a plain VFS path. They erase to
 * `string` at runtime (a brand is compile-time only), so they cross postMessage
 * / structured-clone / HTTP-header boundaries transparently; a value only
 * becomes one via the mint site (`as SyncFs*`), never by accident.
 */
export type SyncFsToken = string & { readonly __syncFsToken: unique symbol };
export type SyncFsNonce = string & { readonly __syncFsNonce: unique symbol };

/**
 * BroadcastChannel name between the SW and the kernel-worker responder, keyed by
 * an **unguessable per-session nonce**.
 *
 * SECURITY: the channel must NOT be joinable by realm workers. A fixed name
 * (e.g. `slicc-sync-fs`) is joinable by any same-origin realm — realm user code
 * has unrestricted `BroadcastChannel` access — which would let a malicious scoop
 * realm harvest another realm's capability token off the channel (full sandbox
 * escape) or spoof responses into another realm's `readFileSync`. Naming the
 * channel with a `crypto.randomUUID` nonce that is distributed ONLY over private
 * paths — into the kernel via `KernelWorkerInitMsg` (a targeted `worker.postMessage`
 * private to that one worker; the nonce rides as a structured-cloned string, not
 * a transferable) and into the SW via the page's `controller.postMessage`
 * (targeted to the SW, never broadcast) — means realms never learn the nonce and
 * cannot enumerate/guess it (122-bit, no BroadcastChannel enumeration API), so
 * the channel is effectively private to the SW + responder.
 */
const SYNC_FS_CHANNEL_PREFIX = 'slicc-sync-fs-';
export function syncFsChannelName(nonce: SyncFsNonce): string {
  return SYNC_FS_CHANNEL_PREFIX + nonce;
}

/** Page → SW handshake message carrying the per-session channel nonce. */
export const SYNC_FS_NONCE_MSG = 'sync-fs-nonce';
export interface SyncFsNonceMsg {
  type: typeof SYNC_FS_NONCE_MSG;
  nonce: SyncFsNonce;
}
/**
 * SW → page request to (re)publish the nonce. Sent when a sync-fs fetch arrives
 * but the SW has no nonce — e.g. after an MV3 SW eviction+respawn dropped its
 * in-memory nonce and `controllerchange` did not re-fire. The page answers by
 * re-publishing the SAME session nonce (a fresh {@link SyncFsNonceMsg} carrying
 * the unchanged nonce — never a newly minted one, since the kernel-worker
 * responder is bound to the original for the session) so sync-fs self-heals (the
 * triggering request fails closed with `EIO`; the next one succeeds).
 */
export const SYNC_FS_NEED_NONCE_MSG = 'sync-fs-need-nonce';
export interface SyncFsNeedNonceMsg {
  type: typeof SYNC_FS_NEED_NONCE_MSG;
}

/** Route the realm's sync XHR targets; the SW's own fetch listener matches it. */
export const SYNC_FS_ROUTE_PREFIX = '/__slicc/fs-sync/';
/** Same route without the trailing slash — the bridge joins the abs path onto it. */
export const SYNC_FS_ROUTE_BASE = '/__slicc/fs-sync';
/**
 * Route for the synchronous `exec` channel. Unlike the fs routes it carries no
 * path — the command rides in the POST body (see {@link SyncExecRequestPayload})
 * so a command string never has to survive URL encoding.
 */
export const SYNC_EXEC_ROUTE = '/__slicc/exec-sync';

/** Per-realm capability token header (realm → SW). */
export const SYNC_FS_TOKEN_HEADER = 'x-slicc-fs-token';
/** POSIX errno header on a non-ok response (SW → realm). */
export const SYNC_FS_ERRNO_HEADER = 'x-slicc-fs-errno';
/**
 * Marker on EVERY genuine sync-fs response. The realm bridge requires it on a
 * 2xx, so a response that did NOT come from the handler (a stale/absent SW
 * letting the XHR hit the network → SPA fallback `200` + `index.html`) is
 * rejected as `EIO` instead of being mis-read as file bytes.
 */
export const SYNC_FS_MARKER_HEADER = 'x-slicc-fs';

/**
 * Set on the fail-closed response when NOBODY acked — as opposed to a
 * responder that acked and then ran out of budget. Both are `503` + `EIO` to
 * the realm (which must not care), but the SW does: an unacked warm-path
 * request is the one signal that its channel set may be stale, and the cue to
 * ask the page(s) to re-publish. See `llm-proxy-sw.ts`.
 */
export const SYNC_FS_NO_RESPONDER_HEADER = 'x-slicc-fs-no-responder';

/**
 * Channel-message discriminants. Constants (not inline literals) so the type
 * and every `postMessage` / comparison in the responder + SW handler reference
 * the SAME symbol — a rename/typo becomes a compile error rather than a silent
 * runtime desync. Mirrors the `SYNC_FS_NONCE_MSG` pattern above.
 */
export const SYNC_FS_REQ_MSG = 'sync-fs-req';
export const SYNC_FS_ACK_MSG = 'sync-fs-ack';
export const SYNC_FS_RES_MSG = 'sync-fs-res';

/** SW → responder: a request to run one op against the token's realm. */
export type SyncFsReqMsg = (SyncFsRequest | SyncExecRequest) & {
  type: typeof SYNC_FS_REQ_MSG;
  id: string;
};
/** responder → SW: receipt, posted synchronously before the async dispatch. */
export type SyncFsAckMsg = { type: typeof SYNC_FS_ACK_MSG; id: string };
/** responder → SW: the dispatch result. */
export type SyncFsResMsg = SyncFsResult & { type: typeof SYNC_FS_RES_MSG; id: string };

/**
 * Worst-case round-trip budget: how long the SW handler waits for a responder
 * reply before failing an op closed (`EIO`). Shared (not a magic number in two
 * bundles) so the responder can retain a settled request `id` at LEAST this
 * long: the SW may re-post the same `id` until this budget elapses, and a
 * re-post arriving after the dedupe entry was evicted would be re-dispatched (a
 * double write / double sudo prompt). Kept below the realm XHR's own 30s
 * `timeout` (`sync-fs-xhr-bridge.ts`) so the SW's authoritative EIO wins the
 * race with the bare XHR-timeout EIO.
 */
export const SYNC_FS_REQUEST_TIMEOUT_MS = 25_000;

/**
 * How long the SW's fetch handler waits for a channel nonce to (re)arrive on a
 * COLD op (no channel registered — a fresh boot or an MV3 SW eviction+respawn)
 * before failing closed. On a cold op the handler asks the page(s) to
 * re-publish (`requestSyncFsNonce`) and awaits up to this long; if a nonce
 * arrives the op proceeds (one extra round-trip) instead of a spurious `EIO`.
 * Kept small and well under {@link SYNC_FS_REQUEST_TIMEOUT_MS} so the wait plus
 * the subsequent round-trip still finishes inside the realm XHR's 30s timeout.
 * The WARM path (a channel already exists) never waits.
 */
export const SYNC_FS_NONCE_WAIT_MS = 2_000;

/**
 * Default round-trip budget for the `exec` channel when the caller supplies no
 * `timeout`. A file read finishes in milliseconds; a build command does not, so
 * the fs budget ({@link SYNC_FS_REQUEST_TIMEOUT_MS}) is far too tight here.
 */
export const SYNC_EXEC_DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Ceiling on a caller-supplied `execSync(cmd, { timeout })`. A blocked realm
 * worker cannot be interrupted, so an unbounded budget would make a runaway
 * command unkillable short of terminating the realm. The responder retains a
 * settled `id` for at least this long (plus a margin) so a late SW re-post
 * replays the cached result instead of re-running the command.
 */
export const SYNC_EXEC_MAX_TIMEOUT_MS = 600_000;

/**
 * Margin the SW handler adds on top of the command budget before failing an
 * exec closed. The dispatcher aborts `ctx.exec` exactly at the budget and then
 * still has to build the `ETIMEDOUT` (or a just-in-time success) result,
 * structured-clone it onto the channel, and have the SW turn it into a
 * `Response`. Without this the two deadlines coincide and the SW's generic
 * `EIO` races — usually wins — against the specific answer the responder is
 * already producing. Kept BELOW the realm bridge's own XHR margin
 * ({@link SYNC_EXEC_XHR_MARGIN_MS}) so the SW response still lands first.
 */
export const SYNC_EXEC_RESPONSE_MARGIN_MS = 2_000;

/**
 * Margin the realm bridge adds on top of the command budget for the blocking
 * XHR's own `timeout`. Larger than {@link SYNC_EXEC_RESPONSE_MARGIN_MS} so the
 * SW's authoritative errno wins the race with the bare XHR-timeout `EIO`; the
 * XHR timeout stays the backstop for a dead SW that never answers at all.
 */
export const SYNC_EXEC_XHR_MARGIN_MS = 5_000;
