/**
 * Shared message types for communication between extension contexts:
 * Side Panel <-> Service Worker <-> Offscreen Document.
 *
 * All messages flow through the service worker as a relay.
 */

import type { ScoopTabState } from './types.js';
import type { MessageAttachment } from '../../webapp/src/core/attachments.js';
import type {
  TerminalControlMsg,
  TerminalEventMsg,
} from '../../webapp/src/shell/terminal-protocol.js';

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
 * import of `createLogger` does. The `follower-sprinkle-bridge` re-imports
 * the canonical `SprinkleSummary` and uses it across the API boundary;
 * this inline shape only governs the wire envelope and stays in lockstep
 * via the compile-time assertion in the bridge.
 */
export interface SprinkleSummaryEnvelope {
  name: string;
  title: string;
  path: string;
  open: boolean;
  autoOpen: boolean;
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

/**
 * Local mirror of `LeaderTrayRuntimeStatus` from
 * `packages/webapp/src/scoops/tray-leader.ts`. Mirrored (not imported) for the
 * same reason as `SprinkleSummaryEnvelope` above — `tray-leader.ts` references
 * `chrome` / `window` / `createLogger`, none of which are available under the
 * webapp-worker tsconfig (`lib: ["ES2022", "WebWorker"]`, `types: []`). The
 * worker pulls `messages.ts` in via `transport-message-channel.ts`, so any
 * `import type` from `tray-leader.ts` (even type-only) drags the whole file
 * into the worker typecheck and breaks the build.
 *
 * The actual `LeaderTrayRuntimeStatus → LeaderTrayRuntimeStatusEnvelope`
 * compatibility is guarded by a compile-time assertion in
 * `follower-sprinkle-bridge.ts` (same pattern as `SprinkleSummary`).
 */
export interface LeaderTrayRuntimeStatusEnvelope {
  state: 'inactive' | 'connecting' | 'leader' | 'reconnecting' | 'error';
  session: {
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
  } | null;
  error: string | null;
  reconnectAttempts?: number;
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
export type ExtensionThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface SetThinkingLevelMsg {
  type: 'set-thinking-level';
  scoopJid: string;
  /** Undefined clears the override; the level falls back to default. */
  level?: ExtensionThinkingLevel;
}

export interface RefreshTrayRuntimeMsg {
  type: 'refresh-tray-runtime';
  /**
   * Snapshot of the panel's tray-join localStorage values, copied into
   * the message because the side panel and offscreen document each have
   * their own localStorage in MV3. Without this, the offscreen never
   * sees a URL the user pasted into the panel and silently fails to
   * start the follower.
   */
  joinUrl?: string | null;
  workerBaseUrl?: string | null;
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

// Detached popout messages — panel ↔ SW coordination.
// See docs/superpowers/specs/2026-05-13-extension-detached-popout-design.md.

/**
 * URL query parameter that marks a detached extension page.
 * The detached popout flow uses these constants to construct the
 * extension URL (`?detached=1`) and to validate inbound claim messages.
 *
 * Spec: docs/superpowers/specs/2026-05-13-extension-detached-popout-design.md
 */
export const DETACHED_RUNTIME_QUERY_NAME = 'detached';
export const DETACHED_RUNTIME_QUERY_VALUE = '1';

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
// ---------------------------------------------------------------------------
// Eight purely additive message types used by the extension-leader tray sync.
// Six panel→offscreen (fire-and-forget pushes + one state request + one RPC
// request) and two offscreen→panel (mode signal + the RPC response).

/**
 * Panel → offscreen: snapshot of the current sprinkles list. Pushed by the
 * panel when it is acting as the leader source so the offscreen leader tray
 * (`LeaderTraySession`) can mirror it to followers. Wire-compatible with
 * `SprinkleSummary` from `tray-sync-protocol.ts` — see the
 * `SprinkleSummaryEnvelope` comment at the top of this file for why the
 * shape is mirrored rather than imported.
 */
export interface LeaderSprinklesSnapshotMsg {
  type: 'leader-sprinkles-snapshot';
  sprinkles: SprinkleSummaryEnvelope[];
}

/**
 * Panel → offscreen: a sprinkle's runtime data changed (the leader's
 * `SprinkleManager.onChange` hook fired). The offscreen relays this to
 * followers via the tray data channel.
 */
export interface LeaderSprinkleUpdateMsg {
  type: 'leader-sprinkle-update';
  sprinkleName: string;
  data: unknown;
}

/**
 * Panel → offscreen: echo of a user message the leader-panel sent into the
 * agent loop, so the offscreen leader tray can mirror the chat into
 * followers without re-emitting it on the local agent. `messageId` is the
 * panel-allocated message id (same one used in `UserMessageMsg`) so the
 * offscreen can dedupe.
 */
export interface LeaderUserMessageEchoMsg {
  type: 'leader-user-message-echo';
  text: string;
  messageId: string;
  attachments?: MessageAttachment[];
}

/**
 * Panel → offscreen: the panel-side leader selected a different scoop as
 * the active one. The offscreen mirrors this to followers so their UI
 * follows along (see `OffscreenClient.setSelectedScoopJid`).
 */
export interface LeaderActiveScoopMsg {
  type: 'leader-active-scoop';
  scoopJid: string;
}

/**
 * Panel → offscreen: ask the offscreen for the current leader-mode state.
 * The offscreen responds with `leader-mode-changed`. Used by panels that
 * boot late (e.g., side panel reopened after offscreen already entered
 * leader mode) to learn the current state without waiting for the next
 * transition.
 */
export interface LeaderRequestLeaderModeStateMsg {
  type: 'leader-request-mode-state';
}

/**
 * Panel → offscreen: round-trip RPC to tear down and restart the leader's
 * tray runtime. `requestId` correlates with the matching
 * `leader-tray-reset-response`.
 */
export interface LeaderTrayResetRequestMsg {
  type: 'leader-tray-reset';
  requestId: string;
}

/**
 * Offscreen → panel: leader-mode entered or left. The panel toggles its
 * leader-only UI affordances based on this signal. Emitted on every
 * transition and in response to `leader-request-mode-state`.
 */
export interface LeaderModeChangedMsg {
  type: 'leader-mode-changed';
  active: boolean;
}

/**
 * Offscreen → panel: response to a `leader-tray-reset` request.
 * `requestId` echoes the original request so the panel can match it.
 * Discriminated by `ok` — the success branch carries `status`; the
 * failure branch carries `error`. Mirrors the pattern used by
 * `FollowerSprinkleFetchResultMsg` below so consumers can narrow on
 * `ok` without defensive `&& resp.status` guards.
 */
export type LeaderTrayResetResponseMsg =
  | {
      type: 'leader-tray-reset-response';
      requestId: string;
      ok: true;
      status: LeaderTrayRuntimeStatusEnvelope;
    }
  | {
      type: 'leader-tray-reset-response';
      requestId: string;
      ok: false;
      error: string;
    };

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
  | SetModelMsg
  | RequestStateMsg
  | RequestScoopMessagesMsg
  | ClearChatMsg
  | ClearFilesystemMsg
  | RefreshModelMsg
  | SetThinkingLevelMsg
  | RefreshTrayRuntimeMsg
  | PanelCdpCommandMsg
  | OAuthRequestMsg
  | SprinkleLickMsg
  | FollowerSprinkleFetchRequestMsg
  | FollowerSprinkleFetchCancelMsg
  | FollowerSprinkleLickMsg
  | WebhookEventMsg
  | SetFollowerForwardingMsg
  | InjectForwardedLickMsg
  | ReloadSkillsMsg
  | ToolUIActionMsg
  | LocalStorageSetMsg
  | LocalStorageRemoveMsg
  | LocalStorageClearMsg
  // Panel-driven terminal session control. Routed by the worker's
  // `TerminalSessionHost`, ignored by `OffscreenBridge`. The full
  // envelope shape lives in `terminal-protocol.ts`.
  | TerminalControlMsg
  | DetachedPopoutRequestMsg
  | DetachedClaimMsg
  | LeaderSprinklesSnapshotMsg
  | LeaderSprinkleUpdateMsg
  | LeaderUserMessageEchoMsg
  | LeaderActiveScoopMsg
  | LeaderRequestLeaderModeStateMsg
  | LeaderTrayResetRequestMsg;

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
  };
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
  | ScoopMessagesReplacedMsg
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
  | LeaderModeChangedMsg
  | LeaderTrayResetResponseMsg;

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
