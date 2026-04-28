/**
 * Shared message types for communication between extension contexts:
 * Side Panel <-> Service Worker <-> Offscreen Document.
 *
 * All messages flow through the service worker as a relay.
 */

import type { ScoopTabState } from './types.js';
import type { MessageAttachment } from '../../webapp/src/core/attachments.js';

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

export interface ClearChatMsg {
  type: 'clear-chat';
}

export interface ClearFilesystemMsg {
  type: 'clear-filesystem';
}

export interface RefreshModelMsg {
  type: 'refresh-model';
}

export interface RefreshTrayRuntimeMsg {
  type: 'refresh-tray-runtime';
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

export type PanelToOffscreenMessage =
  | UserMessageMsg
  | ConeCreateMsg
  | ScoopFeedMsg
  | ScoopDropMsg
  | AbortMsg
  | SetModelMsg
  | RequestStateMsg
  | ClearChatMsg
  | ClearFilesystemMsg
  | RefreshModelMsg
  | RefreshTrayRuntimeMsg
  | PanelCdpCommandMsg
  | OAuthRequestMsg
  | SprinkleLickMsg
  | ReloadSkillsMsg
  | ToolUIActionMsg;

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

export interface ScoopListMsg {
  type: 'scoop-list';
  scoops: Array<{
    jid: string;
    name: string;
    folder: string;
    isCone: boolean;
    assistantLabel: string;
    status: ScoopTabState['status'];
  }>;
}

export interface StateSnapshotMsg {
  type: 'state-snapshot';
  scoops: ScoopListMsg['scoops'];
  activeScoopJid: string | null;
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

export interface OffscreenReadyMsg {
  type: 'offscreen-ready';
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
  | PanelCdpResponseMsg
  | OAuthResultMsg;

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
  payload: CdpProxyMessage | TraySocketEventMessage | OAuthResultMsg | NavigateLickMsg;
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
