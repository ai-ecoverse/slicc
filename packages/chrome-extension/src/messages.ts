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
 * carried an `x-slicc` header. Emitted by the webRequest observer.
 */
export interface NavigateLickMsg {
  type: 'navigate-lick';
  url: string;
  sliccHeader: string;
  title?: string;
  tabId?: number;
}

export type OffscreenToPanelMessage =
  | OffscreenReadyMsg
  | AgentEventMsg
  | ScoopStatusMsg
  | ScoopListMsg
  | StateSnapshotMsg
  | ErrorMsg
  | ScoopCreatedMsg
  | IncomingMessageMsg
  | ScoopMessagesReplacedMsg
  | PanelCdpResponseMsg
  | OAuthResultMsg
  | TrayRuntimeStatusMsg
  // Terminal session events emitted by the worker's `TerminalSessionHost`.
  // Consumed by the panel's `TerminalSessionClient`.
  | TerminalEventMsg;

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
