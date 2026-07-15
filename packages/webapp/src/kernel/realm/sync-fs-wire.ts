/**
 * Single source of truth for the synchronous-fs bridge wire contract.
 *
 * The bridge spans three bundles that can't share a runtime import cheaply —
 * the realm worker (`sync-fs-xhr-bridge.ts`), the kernel-worker responder
 * (`sync-fs-responder.ts`), and the Service Worker (`ui/sync-fs-sw-handler.ts`
 * bundled into `llm-proxy-sw`). This module is **dependency-free** (only string
 * constants + wire types) so every side can import it without dragging logic
 * across bundle boundaries, and a rename can't silently desync the two ends
 * (which would fail at runtime, not compile time).
 */

import type { SyncFsRequest, SyncFsResult } from './sync-fs-dispatch.js';

/** Origin-scoped BroadcastChannel between the SW and the kernel responder. */
export const SYNC_FS_CHANNEL = 'slicc-sync-fs';

/** Route the realm's sync XHR targets; the SW's own fetch listener matches it. */
export const SYNC_FS_ROUTE_PREFIX = '/__slicc/fs-sync/';
/** Same route without the trailing slash — the bridge joins the abs path onto it. */
export const SYNC_FS_ROUTE_BASE = '/__slicc/fs-sync';

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

/** SW → responder: a request to run one fs op against the token's realm. */
export type SyncFsReqMsg = SyncFsRequest & { type: 'sync-fs-req'; id: string };
/** responder → SW: receipt, posted synchronously before the async dispatch. */
export type SyncFsAckMsg = { type: 'sync-fs-ack'; id: string };
/** responder → SW: the dispatch result. */
export type SyncFsResMsg = SyncFsResult & { type: 'sync-fs-res'; id: string };
