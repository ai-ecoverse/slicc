/**
 * Page↔kernel-worker wire protocol.
 *
 * Defines the typed message envelopes exchanged between the browser page
 * and the kernel web-worker (standalone mode) or the extension service
 * worker / offscreen bridge (extension mode). Historically lived in the
 * chrome-extension package; moved here (#1443) so the protocol sits next
 * to its primary consumers.
 */

import type { MessageAttachment } from '../core/attachments.js';
import type { ScoopTabState } from '../scoops/types.js';
import type { TerminalControlMsg, TerminalEventMsg } from '../shell/terminal-protocol.js';

/**
 * Local mirror of `SprinkleSummary` from
 * `packages/webapp/src/scoops/tray-sync-protocol.ts`. Mirrored (not imported)
 * because `tray-sync-protocol.ts` has a value import of `logger.ts`, which
 * depends on the ambient `__DEV__` global. That global is not declared
 * under the webapp-worker tsconfig (which only lists `["ES2022", "WebWorker"]`
 * libs + `"types": []`) and the worker tsconfig pulls this file in via
 * `transport-message-channel.ts`. The `TrayDataChannelLike` reference in
 * `tray-sync-protocol.ts` is an `import type` and would erase at compile
 * time — it's not what breaks the webapp-worker build, only the value
 * import of `createLogger` does. This inline shape only governs the wire
 * envelope; structural compatibility with the canonical type is enforced
 * by the compile-time assignability assertion in
 * `packages/chrome-extension/tests/messages.test.ts` (typechecked in CI).
 */
export interface SprinkleSummaryEnvelope {
  name: string;
  title: string;
  path: string;
  open: boolean;
  autoOpen: boolean;
  icon?: string;
}

/**
 * Structural mirror of webapp's `LickEvent`. `messages.ts` cannot import
 * the real type from `scoops/lick-manager.ts` — doing so pulls
 * `core/logger.ts` (which references the Vite-only `__DEV__` global) into
 * a tsconfig that doesn't declare it, breaking `tsc`. The carrier only
 * needs the fields below; consumers cast to the real `LickEvent`.
 */
export interface ForwardedLickEvent {
  type: string;
  timestamp: string;
  body: unknown;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Side Panel → Offscreen (via service worker relay)
// ---------------------------------------------------------------------------

export interface UserMessageMsg {
  type: 'user-message';
  scoopJid: string;
  text: string;
  messageId: string;
  attachments?: MessageAttachment[];
}

/**
 * Panel → offscreen: bootstrap the cone. Sent exactly once per side-panel
 * session when no cone exists on disk yet. Non-cone scoops are created by
 * the agent's `scoop_scoop` tool inside the offscreen orchestrator, not
 * through this message.
 */
export interface ConeCreateMsg {
  type: 'cone-create';
  name: string;
}

export interface ScoopFeedMsg {
  type: 'scoop-feed';
  scoopJid: string;
  prompt: string;
}

export interface ScoopDropMsg {
  type: 'scoop-drop';
  scoopJid: string;
}

export interface AbortMsg {
  type: 'abort';
  scoopJid: string;
}

export interface DeleteQueuedMessageMsg {
  type: 'delete-queued-message';
  scoopJid: string;
  messageId: string;
}

export interface SetModelMsg {
  type: 'set-model';
  provider: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
}

export interface RequestStateMsg {
  type: 'request-state';
}

/**
 * Ask the worker for the canonical chat history of a scoop. The
 * worker translates the `AgentMessage[]` it holds into the panel's
 * `ChatMessage[]` shape and emits a `scoop-messages-replaced`
 * response. Used after the panel re-mounts (HMR, full reload) so the
 * UI rebuilds from the live agent state instead of from its own
 * potentially-stale `browser-coding-agent` IDB snapshot.
 */
export interface RequestScoopMessagesMsg {
  type: 'request-scoop-messages';
  scoopJid: string;
}

/**
 * Side-effect-free transcript fetch for a scoop. Distinct from
 * `request-scoop-messages` (which triggers the chat panel to
 * wholesale-replace its render via `scoop-messages-replaced`): this
 * one is a pure read used by the scoop-switcher's scope-label
 * tooltip. The worker resolves the most recent transcript it has
 * (in-flight buffer, then live agent state) and flattens it into a
 * single string. The `requestId` correlates the reply.
 */
export interface RequestScoopTranscriptMsg {
  type: 'request-scoop-transcript';
  requestId: string;
  scoopJid: string;
}

/** Reply to {@link RequestScoopTranscriptMsg}. `transcript` is the
 *  flattened text the labeler hands to `quickLabel`; empty string if
 *  the scoop is unknown or has no history yet. */
export interface ScoopTranscriptMsg {
  type: 'scoop-transcript';
  requestId: string;
  scoopJid: string;
  transcript: string;
}

/**
 * Side-effect-free chat-messages fetch for a scoop. Returns the full
 * `ChatMessage[]` shape (unlike `request-scoop-transcript` which
 * flattens to text). Used by the tray leader to send a scoop's history
 * to a follower that selected a different scoop.
 */
export interface RequestScoopChatMessagesMsg {
  type: 'request-scoop-chat-messages';
  requestId: string;
  scoopJid: string;
}

/** Reply to {@link RequestScoopChatMessagesMsg}. */
export interface ScoopChatMessagesMsg {
  type: 'scoop-chat-messages';
  requestId: string;
  scoopJid: string;
  messages: ScoopMessagesReplacedMsg['messages'];
}

/**
 * Panel → engine: session-stats pull (floatbar cost counter + the chip
 * pupils' context-fill). The `requestId` correlates the reply.
 */
export interface RequestSessionStatsMsg {
  type: 'request-session-stats';
  requestId: string;
}

/** Reply to {@link RequestSessionStatsMsg}. */
export interface SessionStatsMsg {
  type: 'session-stats';
  requestId: string;
  /** Total session cost (USD) across all scoops, dropped ones included. */
  totalCost: number;
  /** Per-scoop context-window fill, 0..1 (last assistant turn's usage). */
  fills: Array<{ jid: string; fill: number }>;
  /** Per-model cost breakdown, sorted by cost descending. */
  models: Array<{ model: string; cost: number; turns: number; tokens: number }>;
  /** Per-scoop cost breakdown. */
  scoops: Array<{ name: string; model: string; cost: number; type: 'cone' | 'scoop' }>;
}

export interface ClearChatMsg {
  type: 'clear-chat';
  /** Correlation id so the panel can await the bridge's ack and avoid
   *  reloading before the live cone context has actually been cleared
   *  (the offscreen document survives panel reload in extension mode,
   *  so a missed clear would leave the old agent state running). */
  requestId: string;
}

export interface ClearChatAckMsg {
  type: 'clear-chat-ack';
  requestId: string;
}

export interface ClearFilesystemMsg {
  type: 'clear-filesystem';
}

export interface RefreshModelMsg {
  type: 'refresh-model';
}

/**
 * Discriminated literal for `ThinkingLevel`. Mirrors the union exported
 * by `packages/webapp/src/scoops/types.ts` — duplicated here so the
 * extension messages module stays free of webapp imports (the extension
 * source set is consumed by both the panel and the offscreen contexts,
 * and we don't want to drag the scoop config layer into the message
 * envelopes).
 */
export type ExtensionThinkingLevel =
  | 'off'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';

export interface SetThinkingLevelMsg {
  type: 'set-thinking-level';
  scoopJid: string;
  /** Undefined clears the override; the level falls back to default. */
  level?: ExtensionThinkingLevel;
  /** Raw API effort override retained for provider-specific stream mappings. */
  effortOverride?: string;
}

export interface PanelCdpCommandMsg {
  type: 'panel-cdp-command';
  id: number;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

/** Request OAuth flow via service worker (extension mode). */
export interface OAuthRequestMsg {
  type: 'oauth-request';
  providerId: string;
  authorizeUrl: string;
  /**
   * Whether to show the auth window. Silent renewals (prompt=none) pass
   * `false` so `chrome.identity.launchWebAuthFlow` runs without UI; explicit
   * user-initiated logins pass `true` (the default when omitted).
   */
  interactive?: boolean;
}

/** Sprinkle lick event from side panel to offscreen agent. */
export interface SprinkleLickMsg {
  type: 'sprinkle-lick';
  sprinkleName: string;
  body: unknown;
  /** Optional target scoop for routed sprinkle lick events. */
  targetScoop?: string;
  /** Optional origin label for follower-forwarded licks. */
  originLabel?: string;
}

/**
 * Side panel → offscreen: when the extension is acting as a tray follower,
 * request the leader's `.shtml` content for a sprinkle (which the offscreen
 * `FollowerSyncManager` answers via `sprinkle.fetch` → chunked `sprinkle.content`
 * reassembly). The `id` is generated panel-side and echoed back on
 * `follower-sprinkle-fetch-result`.
 *
 * Intra-extension only — never crosses the WebRTC wire.
 */
export interface FollowerSprinkleFetchRequestMsg {
  type: 'follower-sprinkle-fetch';
  id: string;
  sprinkleName: string;
}

/**
 * Side panel → offscreen: panel-side proxy timed out on a fetch (default
 * 15 s); ask the offscreen to drop the corresponding waiter so it doesn't
 * accumulate across retries. The panel may have already issued a follow-up
 * fetch for the same sprinkle name (R2-IMP-2: without this, repeated
 * retries grow `sprinkleContentWaiters` unboundedly while the leader
 * stays mute).
 *
 * Intra-extension only — never crosses the WebRTC wire.
 */
export interface FollowerSprinkleFetchCancelMsg {
  type: 'follower-sprinkle-fetch-cancel';
  sprinkleName: string;
}

/**
 * Side panel → offscreen: in extension follower mode, forward a sprinkle lick
 * to the leader (`sprinkle.lick` on the wire). Distinct from `sprinkle-lick`,
 * which would route the lick to a local scoop instead of the remote leader.
 *
 * Intra-extension only — never crosses the WebRTC wire.
 */
export interface FollowerSprinkleLickMsg {
  type: 'follower-sprinkle-lick';
  sprinkleName: string;
  body: unknown;
  targetScoop?: string;
}

/**
 * Webhook event relayed from the page-side LeaderTrayManager into the
 * worker-side LickManager. The page-side leader receives `webhook.event`
 * control messages from the Cloudflare tray and forwards them here so the
 * lick manager (which lives in the kernel worker) can route them to the
 * registered scoop. Fire-and-forget; matches LickManager.handleWebhookEvent
 * signature (the tray's `timestamp` field is regenerated by LickManager).
 */
export interface WebhookEventMsg {
  type: 'lick-webhook-event';
  webhookId: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Page→worker (standalone follower): toggle the worker LickManager's forwarder. */
export interface SetFollowerForwardingMsg {
  type: 'set-follower-forwarding';
  enabled: boolean;
}

/** Page→worker (standalone leader): inject a follower-forwarded lick into the worker LickManager. */
export interface InjectForwardedLickMsg {
  type: 'inject-forwarded-lick';
  event: ForwardedLickEvent;
}

/** Worker→page (standalone follower): a forwardable lick the page must relay to the leader. */
export interface ForwardLickMsg {
  type: 'forward-lick';
  event: ForwardedLickEvent;
}

/**
 * Cherry host event relayed from the page-side `LeaderSyncManager` into the
 * worker-side `LickManager`. The page-side leader receives `cherry.host_event`
 * over a follower's data channel (its embedded cherry host page called
 * `emitHostEvent`) and forwards it here so the lick manager (which lives in the
 * kernel worker) can emit a `'cherry'` lick to the cone. Fire-and-forget;
 * matches `Orchestrator.handleCherryHostEvent` (the `'cherry'` lick `timestamp`
 * is generated worker-side). `cherryRuntimeId` is the owning follower's runtime
 * id, resolved leader-side; `undefined` when the follower is no longer mapped.
 */
export interface CherryHostEventMsg {
  type: 'lick-cherry-host-event';
  cherryRuntimeId: string | undefined;
  name: string;
  detail?: unknown;
}

/**
 * Page-side leader → worker: a preview-bridge lifecycle lick (`'preview'`).
 * The page-side `LeaderSyncManager` builds the full `LickEvent` (connect /
 * disconnect, rate-limited, `--quiet`-suppressed) in `onBridgeConnected` /
 * `onBridgeDisconnected` and forwards it here so the worker-resident
 * `LickManager` can emit it to the cone. Carried as the structural
 * `ForwardedLickEvent` (the real `LickEvent` cannot be imported here — see
 * above); `Orchestrator.handlePreviewLick` casts it back. Fire-and-forget.
 */
export interface PreviewLickMsg {
  type: 'lick-preview';
  event: ForwardedLickEvent;
}

/** Request skill reload after upskill install. */
export interface ReloadSkillsMsg {
  type: 'reload-skills';
}

export interface ToolUIActionMsg {
  type: 'tool-ui-action';
  requestId: string;
  action: string;
  data?: unknown;
}

/**
 * Live `localStorage` sync. The standalone kernel worker has no
 * real `localStorage`; it runs on a Map-backed shim seeded from
 * the page's `localStorage` snapshot at boot
 * (`KernelWorkerInitMsg.localStorageSeed`). After boot, page-side
 * writes need to keep flowing to the worker so changes the user
 * makes (e.g. swapping providers, updating model selection) are
 * visible to the agent immediately.
 *
 * Extension mode never sends these — the side panel and offscreen
 * share the extension origin's `localStorage` natively.
 */
export interface LocalStorageSetMsg {
  type: 'local-storage-set';
  key: string;
  value: string;
}

export interface LocalStorageRemoveMsg {
  type: 'local-storage-remove';
  key: string;
}

export interface LocalStorageClearMsg {
  type: 'local-storage-clear';
}

// ---------------------------------------------------------------------------
// VFS read RPCs
// ---------------------------------------------------------------------------
// Read-only RPC surface that lets the panel observe the worker-owned VFS
// without touching OPFS directly. Mirrors the `LocalVfsClient` interface
// shape in `packages/webapp/src/kernel/local-vfs-client.ts`.
//
// Mirrored (not imported) for the same reason as `SprinkleSummaryEnvelope`
// above — the `fs/types.ts` import would drag the webapp fs module graph
// into the webapp-worker tsconfig (`lib: ["ES2022","WebWorker"]`,
// `types: []`), which `transport-message-channel.ts` pulls this file in
// for. A structural-mirror keeps the envelope free of webapp imports;
// `vfs-rpc-host.ts` casts between the wire shape and the real `Stats` /
// `DirEntry` types.

/** Wire mirror of `DirEntry` from `webapp/src/fs/types.ts`. */
export interface VfsDirEntryEnvelope {
  name: string;
  type: 'file' | 'directory' | 'symlink';
}

/** Wire mirror of `Stats` from `webapp/src/fs/types.ts`. */
export interface VfsStatsEnvelope {
  type: 'file' | 'directory' | 'symlink';
  size: number;
  mtime: number;
  ctime: number;
  isSymlink?: boolean;
  symlinkTarget?: string;
}

/**
 * Error envelope carried on the failure branch of every VFS RPC
 * response. `code` mirrors `FsErrorCode` from `webapp/src/fs/types.ts`
 * (POSIX-shaped: `ENOENT`, `ENOTDIR`, `EISDIR`, …) so panel-side
 * callers can branch on it without an enum import.
 */
export interface VfsErrorEnvelope {
  code: string;
  message: string;
  path?: string;
}

/** Panel → worker: list directory entries at `path`. */
export interface VfsReadDirRequestMsg {
  type: 'vfs-read-dir';
  /** Correlation id echoed on the matching `vfs-read-dir-result`. */
  requestId: string;
  path: string;
}

/** Panel → worker: read a file at `path`. */
export interface VfsReadFileRequestMsg {
  type: 'vfs-read-file';
  /** Correlation id echoed on the matching `vfs-read-file-result`. */
  requestId: string;
  path: string;
  /** Default `'utf-8'` (matches `VirtualFS.readFile`). */
  encoding?: 'utf-8' | 'binary';
}

/** Panel → worker: stat the entry at `path`. */
export interface VfsStatRequestMsg {
  type: 'vfs-stat';
  /** Correlation id echoed on the matching `vfs-stat-result`. */
  requestId: string;
  path: string;
}

export type VfsReadRequestMsg = VfsReadDirRequestMsg | VfsReadFileRequestMsg | VfsStatRequestMsg;

/** Worker → panel: response to `vfs-read-dir`. */
export type VfsReadDirResultMsg =
  | { type: 'vfs-read-dir-result'; requestId: string; ok: true; entries: VfsDirEntryEnvelope[] }
  | { type: 'vfs-read-dir-result'; requestId: string; ok: false; error: VfsErrorEnvelope };

/**
 * Worker → panel: response to `vfs-read-file`.
 *
 * Binary reads carry the raw `Uint8Array` so the worker can hand
 * ownership of the underlying `ArrayBuffer` to the panel via the
 * transport's transfer list (`MessageChannel.postMessage(msg, [buf])`).
 * The chrome.runtime adapter does not support transferables and silently
 * structured-clones the bytes instead — the wire shape is identical
 * either way. Text reads stay as `string` (no transfer benefit).
 */
export type VfsReadFileResultMsg =
  | { type: 'vfs-read-file-result'; requestId: string; ok: true; encoding: 'utf-8'; data: string }
  | {
      type: 'vfs-read-file-result';
      requestId: string;
      ok: true;
      encoding: 'binary';
      data: Uint8Array;
    }
  | { type: 'vfs-read-file-result'; requestId: string; ok: false; error: VfsErrorEnvelope };

/** Worker → panel: response to `vfs-stat`. */
export type VfsStatResultMsg =
  | { type: 'vfs-stat-result'; requestId: string; ok: true; stats: VfsStatsEnvelope }
  | { type: 'vfs-stat-result'; requestId: string; ok: false; error: VfsErrorEnvelope };

export type VfsReadResultMsg = VfsReadDirResultMsg | VfsReadFileResultMsg | VfsStatResultMsg;

// ---------------------------------------------------------------------------
// VFS write RPCs
// ---------------------------------------------------------------------------
// Write-side RPC surface that lets the panel mutate the worker-owned VFS
// without touching OPFS directly. Mirrors the writable subset of
// `VirtualFS` used by `session-freezer.ts` (`writeFile`, `mkdir`, `rm`,
// `flush`).
//
// Mirrored (not imported) for the same reason as `VfsReadDirRequestMsg`
// above — the `fs/types.ts` import would drag the webapp fs module
// graph into the webapp-worker tsconfig.
//
// Binary `writeFile` payloads carry the raw `Uint8Array` and request
// transfer of the backing `ArrayBuffer` (zero-copy on the
// `MessageChannel` adapter; structured-clone copy on chrome.runtime,
// which silently ignores the transfer list). Text payloads stay as
// `string` (no transfer benefit).

/** Panel → worker: write file content at `path`. */
export type VfsWriteFileRequestMsg =
  | {
      type: 'vfs-write-file';
      /** Correlation id echoed on the matching `vfs-write-file-result`. */
      requestId: string;
      path: string;
      encoding: 'utf-8';
      data: string;
      /** Create parent directories if they don't exist. Default: false. */
      recursive?: boolean;
    }
  | {
      type: 'vfs-write-file';
      requestId: string;
      path: string;
      encoding: 'binary';
      data: Uint8Array;
      recursive?: boolean;
    };

/** Panel → worker: create directory at `path`. */
export interface VfsMkdirRequestMsg {
  type: 'vfs-mkdir';
  /** Correlation id echoed on the matching `vfs-mkdir-result`. */
  requestId: string;
  path: string;
  /** Create parent directories if they don't exist. Default: false. */
  recursive?: boolean;
}

/** Panel → worker: remove the entry at `path`. */
export interface VfsRmRequestMsg {
  type: 'vfs-rm';
  /** Correlation id echoed on the matching `vfs-rm-result`. */
  requestId: string;
  path: string;
  /** Remove directories and their contents recursively. Default: false. */
  recursive?: boolean;
}

/**
 * Panel → worker: flush the VFS to durable storage. Used by the freezer
 * after a sequence of writes so the bytes land on disk before a
 * subsequent `location.reload()` could race the IndexedDB debounce.
 */
export interface VfsFlushRequestMsg {
  type: 'vfs-flush';
  /** Correlation id echoed on the matching `vfs-flush-result`. */
  requestId: string;
}

/** Panel → worker: list live user mount points from the canonical VFS. */
export interface VfsListMountPointsRequestMsg {
  type: 'vfs-list-mount-points';
  /** Correlation id echoed on the matching `vfs-list-mount-points-result`. */
  requestId: string;
}

/** Wire mirror of a user-visible `VirtualFS.listMountPoints()` entry. */
export interface VfsMountPointEnvelope {
  path: string;
  kind: 'local' | 's3' | 'da' | 'proc';
}

export type VfsWriteRequestMsg =
  | VfsWriteFileRequestMsg
  | VfsMkdirRequestMsg
  | VfsRmRequestMsg
  | VfsFlushRequestMsg
  | VfsListMountPointsRequestMsg;

/**
 * Worker → panel: response to `vfs-write-file`. Success branch carries
 * no payload (writes are void); failure branch carries an error envelope
 * shaped like the read-side failures.
 */
export type VfsWriteFileResultMsg =
  | { type: 'vfs-write-file-result'; requestId: string; ok: true }
  | { type: 'vfs-write-file-result'; requestId: string; ok: false; error: VfsErrorEnvelope };

/** Worker → panel: response to `vfs-mkdir`. */
export type VfsMkdirResultMsg =
  | { type: 'vfs-mkdir-result'; requestId: string; ok: true }
  | { type: 'vfs-mkdir-result'; requestId: string; ok: false; error: VfsErrorEnvelope };

/** Worker → panel: response to `vfs-rm`. */
export type VfsRmResultMsg =
  | { type: 'vfs-rm-result'; requestId: string; ok: true }
  | { type: 'vfs-rm-result'; requestId: string; ok: false; error: VfsErrorEnvelope };

/** Worker → panel: response to `vfs-flush`. */
export type VfsFlushResultMsg =
  | { type: 'vfs-flush-result'; requestId: string; ok: true }
  | { type: 'vfs-flush-result'; requestId: string; ok: false; error: VfsErrorEnvelope };

/** Worker → panel: response to `vfs-list-mount-points`. */
export type VfsListMountPointsResultMsg =
  | {
      type: 'vfs-list-mount-points-result';
      requestId: string;
      ok: true;
      mountPoints: VfsMountPointEnvelope[];
    }
  | {
      type: 'vfs-list-mount-points-result';
      requestId: string;
      ok: false;
      error: VfsErrorEnvelope;
    };

export type VfsWriteResultMsg =
  | VfsWriteFileResultMsg
  | VfsMkdirResultMsg
  | VfsRmResultMsg
  | VfsFlushResultMsg
  | VfsListMountPointsResultMsg;

// Detached popout messages — panel ↔ SW coordination.
// See docs/superpowers/specs/2026-05-13-extension-detached-popout-design.md.

/**
 * URL query parameter that marks a detached extension page.
 * Detection uses presence semantics (`.has('detached')`) — any value works.
 *
 * Spec: docs/superpowers/specs/2026-05-13-extension-detached-popout-design.md
 */
export const DETACHED_RUNTIME_QUERY_NAME = 'detached';

/**
 * URL query parameter the service worker appends to the pinned leader-tab
 * URL carrying the extension id. The leader page reads it to open the
 * `chrome.runtime.connect(<id>, { name: EXTENSION_BRIDGE_PORT_NAME })` Port
 * — `chrome.runtime.id` is undefined on an externally_connectable page, so
 * the id must be passed in out of band.
 */
export const LEADER_EXT_ID_QUERY_NAME = 'ext';

/** URL query name/value marking the pinned hosted leader tab the thin extension opens. */
export const LEADER_RUNTIME_QUERY_NAME = 'slicc';
export const LEADER_RUNTIME_QUERY_VALUE = 'leader';

export interface DetachedPopoutRequestMsg {
  type: 'detached-popout-request';
}

export interface DetachedClaimMsg {
  type: 'detached-claim';
}

export interface DetachedActiveMsg {
  type: 'detached-active';
}

// ---------------------------------------------------------------------------
// Leader-sync envelopes (issue #682)
// NOTE: not every member of this union actually reaches the offscreen
// document. Several (e.g., OAuthRequestMsg, DetachedPopoutRequestMsg,
// DetachedClaimMsg) are panel→SW messages that the SW handles directly
// and never forwards. The union name is historical; the envelope
// `source: 'panel'` is what discriminates the wire path. Splitting by
// destination would force a second `source` tag at the call sites.
export type PanelToOffscreenMessage =
  | UserMessageMsg
  | ConeCreateMsg
  | ScoopFeedMsg
  | ScoopDropMsg
  | AbortMsg
  | DeleteQueuedMessageMsg
  | SetModelMsg
  | RequestStateMsg
  | RequestScoopMessagesMsg
  | RequestScoopTranscriptMsg
  | RequestScoopChatMessagesMsg
  | RequestSessionStatsMsg
  | ClearChatMsg
  | ClearFilesystemMsg
  | RefreshModelMsg
  | SetThinkingLevelMsg
  | PanelCdpCommandMsg
  | OAuthRequestMsg
  | SprinkleLickMsg
  | FollowerSprinkleFetchRequestMsg
  | FollowerSprinkleFetchCancelMsg
  | FollowerSprinkleLickMsg
  | WebhookEventMsg
  | SetFollowerForwardingMsg
  | InjectForwardedLickMsg
  | CherryHostEventMsg
  | PreviewLickMsg
  | ReloadSkillsMsg
  | ToolUIActionMsg
  | LocalStorageSetMsg
  | LocalStorageRemoveMsg
  | LocalStorageClearMsg
  // Panel-driven terminal session control. Routed by the worker's
  // `TerminalSessionHost`, ignored by `Bridge`. The full
  // envelope shape lives in `terminal-protocol.ts`.
  | TerminalControlMsg
  // Panel-driven VFS read RPCs. Routed by the worker's `VfsRpcHost`,
  // ignored by `Bridge`. Defined above as `VfsReadRequestMsg`.
  | VfsReadRequestMsg
  // Panel-driven VFS write RPCs. Routed by the worker's
  // `VfsRpcHost` when a writable backend is wired; otherwise the
  // host replies with an EACCES failure envelope. Ignored by
  // `Bridge`.
  | VfsWriteRequestMsg
  | DetachedPopoutRequestMsg
  | DetachedClaimMsg;

// ---------------------------------------------------------------------------
// Offscreen → Side Panel (via service worker relay)
// ---------------------------------------------------------------------------

export interface AgentEventMsg {
  type: 'agent-event';
  scoopJid: string;
  eventType:
    | 'text_delta'
    | 'tool_start'
    | 'tool_end'
    | 'turn_end'
    | 'response_done'
    | 'tool_ui'
    | 'tool_ui_done';
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: string;
  isError?: boolean;
  requestId?: string;
  html?: string;
}

export interface ScoopStatusMsg {
  type: 'scoop-status';
  scoopJid: string;
  status: ScoopTabState['status'];
}

/**
 * Fired by the offscreen agent's compaction transformer as it enters
 * and leaves the summarize / memory-extract LLM phases. The panel
 * renders a ghost-bubble affordance while the state is non-idle so the
 * user knows why the agent is silent. `'idle'` clears the affordance.
 */
export interface CompactionStateMsg {
  type: 'compaction-state';
  scoopJid: string;
  state: 'summarizing' | 'extracting-memory' | 'idle';
}

/**
 * Subset of `ScoopConfig` (see `packages/webapp/src/scoops/types.ts`)
 * carried across the offscreen → panel boundary. The panel only needs
 * the persisted-per-scoop bits that drive the UI affordances (model
 * pill capability detection + brain-icon thinking level). Sandbox
 * shape (visiblePaths/writablePaths/allowedCommands) is intentionally
 * NOT mirrored here — the panel never reads those.
 */
export interface ScoopSnapshotConfig {
  modelId?: string;
  thinkingLevel?: ExtensionThinkingLevel;
}

export interface ScoopListMsg {
  type: 'scoop-list';
  scoops: Array<{
    jid: string;
    name: string;
    folder: string;
    isCone: boolean;
    assistantLabel: string;
    status: ScoopTabState['status'];
    /**
     * Persisted per-scoop config snapshot. Optional because the cone
     * (and freshly-created scoops with no overrides) may have no
     * recorded config. The panel reads `config?.modelId` /
     * `config?.thinkingLevel` to drive model-capability detection
     * and the brain-icon's persisted level on reconnect / scoop
     * switch.
     */
    config?: ScoopSnapshotConfig;
  }>;
}

export interface StateSnapshotMsg {
  type: 'state-snapshot';
  scoops: ScoopListMsg['scoops'];
  activeScoopJid: string | null;
  /**
   * Optional tray runtime snapshot, included so a panel attaching late
   * (e.g. side panel reopened after the offscreen leader is already up)
   * sees the leader's join URL without waiting for the next status
   * change. Older offscreen builds may omit this.
   */
  trayRuntimeStatus?: { leader: TrayLeaderStatusSnapshot; follower: TrayFollowerStatusSnapshot };
}

export interface ErrorMsg {
  type: 'error';
  scoopJid: string;
  error: string;
}

export interface ScoopCreatedMsg {
  type: 'scoop-created';
  scoop: ScoopListMsg['scoops'][number];
}

export interface IncomingMessageMsg {
  type: 'incoming-message';
  scoopJid: string;
  message: {
    id: string;
    content: string;
    attachments?: MessageAttachment[];
    channel: string;
    senderName: string;
    fromAssistant: boolean;
    timestamp: string;
    /** Actionable-lick id (sudo-request) so the panel can flip its card later. */
    lickId?: string;
    /** Initial actionable-lick state: pending / confirmed / dismissed. */
    lickState?: 'pending' | 'confirmed' | 'dismissed';
  };
}

/**
 * Offscreen → panel: an already-delivered message changed its render-relevant
 * state in place (no new row). Currently emitted when an actionable lick
 * (sudo-request) settles so the panel flips the rendered card. The panel
 * locates the card by `lickId`.
 */
export interface MessageUpdatedMsg {
  type: 'message-updated';
  scoopJid: string;
  messageId: string;
  lickId?: string;
  lickState?: 'pending' | 'confirmed' | 'dismissed';
}

/**
 * Wholesale replace the chat history for a given scoop. Used when the
 * offscreen acts as a tray follower and the leader sends a snapshot —
 * the panel needs to drop whatever it had cached and render the
 * leader's view. The bridge persists to IndexedDB before emitting so
 * a panel reload picks up the same messages.
 */
export interface ScoopMessagesReplacedMsg {
  type: 'scoop-messages-replaced';
  scoopJid: string;
  messages: Array<{
    id: string;
    role: 'user' | 'assistant';
    content: string;
    attachments?: MessageAttachment[];
    timestamp: number;
    source?: string;
    channel?: string;
    toolCalls?: Array<{
      id: string;
      name: string;
      input: unknown;
      result?: string;
      isError?: boolean;
    }>;
    isStreaming?: boolean;
  }>;
}

export interface OffscreenReadyMsg {
  type: 'offscreen-ready';
}

/**
 * Snapshot of the leader/follower tray runtime status, mirrored from
 * the offscreen document into the side panel so the avatar popover
 * (`Layout.appendTrayMenu`) can render the same "Enable multi-browser
 * sync" surface in extension mode that standalone has. The panel
 * applies the snapshot via `setLeaderTrayRuntimeStatus` /
 * `setFollowerTrayRuntimeStatus` so its module-level singletons match
 * offscreen — without this, the panel's singletons stay 'inactive'
 * because the actual managers run in offscreen.
 */
export interface TrayRuntimeStatusMsg {
  type: 'tray-runtime-status';
  leader: TrayLeaderStatusSnapshot;
  follower: TrayFollowerStatusSnapshot;
}

/**
 * Mirror of `LeaderTraySession` from `tray-leader.ts`. Carried on the
 * wire so the panel-side singleton matches offscreen field-for-field —
 * panel consumers like the lick-WebSocket `create_webhook` handler in
 * `ui/main.ts` read `session.webhookUrl` to build tray-aware webhook
 * URLs and would silently fall back to local URLs if we shipped only a
 * subset.
 */
export interface TrayLeaderSessionSnapshot {
  workerBaseUrl: string;
  trayId: string;
  createdAt: string;
  controllerId: string;
  controllerUrl: string;
  joinUrl: string;
  webhookUrl: string;
  leaderKey?: string;
  leaderWebSocketUrl?: string | null;
  runtime: string;
}

export interface TrayLeaderStatusSnapshot {
  state: 'inactive' | 'connecting' | 'leader' | 'reconnecting' | 'error';
  session: TrayLeaderSessionSnapshot | null;
  error: string | null;
  reconnectAttempts: number;
}

export interface TrayFollowerStatusSnapshot {
  state: 'inactive' | 'connecting' | 'connected' | 'reconnecting' | 'error';
  joinUrl: string | null;
  trayId: string | null;
  error: string | null;
  lastError: string | null;
  reconnectAttempts: number;
  attachAttempts: number;
  lastAttachCode: string | null;
  connectingSince: number | null;
  lastPingTime: number | null;
}

export interface PanelCdpResponseMsg {
  type: 'panel-cdp-response';
  id: number;
  result?: Record<string, unknown>;
  error?: string;
}

/** OAuth result from service worker back to requesting context. */
export interface OAuthResultMsg {
  type: 'oauth-result';
  providerId: string;
  code?: string;
  state?: string;
  error?: string;
  /** Full redirect URL — needed for implicit grant (token in fragment). */
  redirectUrl?: string;
}

/**
 * Service worker → offscreen: a main-frame document response in some tab
 * advertised a SLICC handoff `Link` rel. Emitted by the webRequest observer.
 */
export interface NavigateLickMsg {
  type: 'navigate-lick';
  /** The URL of the document whose response advertised the handoff. */
  url: string;
  /** Verb identified by the link's rel: `handoff` (prose) | `upskill` (URL). */
  verb: 'handoff' | 'upskill';
  /** Resolved absolute URL of the link target. */
  target: string;
  /** Free-form prose instruction (handoff verb). */
  instruction?: string;
  /**
   * Optional branch carried by the upskill rel's `branch` Link param
   * (upskill verb only — handoff rel never sets these).
   */
  branch?: string;
  /**
   * Optional sub-path under the upskill repo carried by the `path` Link
   * param (upskill verb only). Canonical directory form — a trailing
   * `/SKILL.md` has already been stripped by the extractor.
   */
  path?: string;
  /** Page title at the time of the response, if available. */
  title?: string;
  tabId?: number;
}

/**
 * Offscreen → panel: in extension follower mode, the leader has sent a new
 * sprinkle list. The panel-side `SprinkleFollowerController` reconciles this
 * against its open set. The `sprinkles` shape mirrors `SprinkleSummary` from
 * `tray-sync-protocol.ts` — see the `SprinkleSummaryEnvelope` comment at the
 * top of this file for why it isn't imported directly.
 *
 * Intra-extension only — never crosses the WebRTC wire.
 */
export interface FollowerSprinklesListMsg {
  type: 'follower-sprinkles-list';
  sprinkles: SprinkleSummaryEnvelope[];
}

/**
 * Offscreen → panel: in extension follower mode, the leader has pushed a
 * `sprinkle.update` payload. The panel routes it to the matching open
 * sprinkle's update listeners.
 *
 * Intra-extension only — never crosses the WebRTC wire.
 */
export interface FollowerSprinkleUpdateMsg {
  type: 'follower-sprinkle-update';
  sprinkleName: string;
  data: unknown;
}

/**
 * Offscreen → panel: result of a `follower-sprinkle-fetch` request. Modeled as
 * a discriminated success/error union so the type itself enforces the "exactly
 * one of content/error" invariant — previously a pair of `?` fields could
 * accidentally allow `{}` or `{ content, error }`. Consumers narrow on `ok`.
 *
 * Intra-extension only — never crosses the WebRTC wire.
 */
export type FollowerSprinkleFetchResultMsg =
  | { type: 'follower-sprinkle-fetch-result'; id: string; ok: true; content: string }
  | { type: 'follower-sprinkle-fetch-result'; id: string; ok: false; error: string };

export type OffscreenToPanelMessage =
  | OffscreenReadyMsg
  | AgentEventMsg
  | ScoopStatusMsg
  | CompactionStateMsg
  | ScoopListMsg
  | StateSnapshotMsg
  | ErrorMsg
  | ScoopCreatedMsg
  | IncomingMessageMsg
  | MessageUpdatedMsg
  | ScoopMessagesReplacedMsg
  | ScoopTranscriptMsg
  | ScoopChatMessagesMsg
  | SessionStatsMsg
  | PanelCdpResponseMsg
  | OAuthResultMsg
  | TrayRuntimeStatusMsg
  | ClearChatAckMsg
  | FollowerSprinklesListMsg
  | FollowerSprinkleUpdateMsg
  | FollowerSprinkleFetchResultMsg
  | ForwardLickMsg
  // Terminal session events emitted by the worker's `TerminalSessionHost`.
  // Consumed by the panel's `TerminalSessionClient`.
  | TerminalEventMsg
  // VFS read RPC responses emitted by the worker's `VfsRpcHost`.
  // Defined above as `VfsReadResultMsg`.
  | VfsReadResultMsg
  // VFS write RPC responses emitted by the worker's `VfsRpcHost`.
  // Defined above as `VfsWriteResultMsg`.
  | VfsWriteResultMsg;

// ---------------------------------------------------------------------------
// Offscreen ↔ Service Worker (CDP proxy)
// ---------------------------------------------------------------------------

export interface CdpCommandMsg {
  type: 'cdp-command';
  id: number;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

export interface CdpResponseMsg {
  type: 'cdp-response';
  id: number;
  result?: Record<string, unknown>;
  error?: string;
}

export interface CdpEventMsg {
  type: 'cdp-event';
  method: string;
  params?: Record<string, unknown>;
}

export type CdpProxyMessage = CdpCommandMsg | CdpResponseMsg | CdpEventMsg;

export interface TraySocketOpenMsg {
  type: 'tray-socket-open';
  id: number;
  url: string;
}

export interface TraySocketSendMsg {
  type: 'tray-socket-send';
  id: number;
  data: string;
}

export interface TraySocketCloseMsg {
  type: 'tray-socket-close';
  id: number;
  code?: number;
  reason?: string;
}

export interface TraySocketOpenedMsg {
  type: 'tray-socket-opened';
  id: number;
}

export interface TraySocketMessageMsg {
  type: 'tray-socket-message';
  id: number;
  data: string;
}

export interface TraySocketErrorMsg {
  type: 'tray-socket-error';
  id: number;
  error?: string;
}

export interface TraySocketClosedMsg {
  type: 'tray-socket-closed';
  id: number;
}

export type TraySocketCommandMessage = TraySocketOpenMsg | TraySocketSendMsg | TraySocketCloseMsg;
export type TraySocketEventMessage =
  | TraySocketOpenedMsg
  | TraySocketMessageMsg
  | TraySocketErrorMsg
  | TraySocketClosedMsg;

// ---------------------------------------------------------------------------
// Envelope — all messages are wrapped with a source tag for routing
// ---------------------------------------------------------------------------

export interface OffscreenEnvelope {
  source: 'offscreen';
  payload: OffscreenToPanelMessage | CdpProxyMessage | TraySocketCommandMessage;
}

export interface PanelEnvelope {
  source: 'panel';
  payload: PanelToOffscreenMessage;
}

export interface ServiceWorkerEnvelope {
  source: 'service-worker';
  payload:
    | CdpProxyMessage
    | TraySocketEventMessage
    | OAuthResultMsg
    | NavigateLickMsg
    | DetachedActiveMsg;
}

export type ExtensionMessage = OffscreenEnvelope | PanelEnvelope | ServiceWorkerEnvelope;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Type guard for extension messages. */
export function isExtensionMessage(msg: unknown): msg is ExtensionMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'source' in msg &&
    'payload' in msg &&
    typeof (msg as ExtensionMessage).source === 'string'
  );
}
