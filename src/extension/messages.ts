/**
 * Shared message types for communication between extension contexts:
 * Side Panel <-> Service Worker <-> Offscreen Document.
 *
 * All messages flow through the service worker as a relay.
 */

import type { ScoopTabState } from '../scoops/types.js';

// ---------------------------------------------------------------------------
// Side Panel → Offscreen (via service worker relay)
// ---------------------------------------------------------------------------

export interface UserMessageMsg {
  type: 'user-message';
  scoopJid: string;
  text: string;
  messageId: string;
}

export interface ScoopCreateMsg {
  type: 'scoop-create';
  name: string;
  isCone: boolean;
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
}

export type PanelToOffscreenMessage =
  | UserMessageMsg
  | ScoopCreateMsg
  | ScoopFeedMsg
  | ScoopDropMsg
  | AbortMsg
  | SetModelMsg
  | RequestStateMsg
  | ClearChatMsg
  | ClearFilesystemMsg
  | RefreshModelMsg
  | PanelCdpCommandMsg
  | OAuthRequestMsg
  | SprinkleLickMsg;

// ---------------------------------------------------------------------------
// Offscreen → Side Panel (via service worker relay)
// ---------------------------------------------------------------------------

export interface AgentEventMsg {
  type: 'agent-event';
  scoopJid: string;
  eventType: 'text_delta' | 'tool_start' | 'tool_end' | 'turn_end' | 'response_done';
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: string;
  isError?: boolean;
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

// ---------------------------------------------------------------------------
// Envelope — all messages are wrapped with a source tag for routing
// ---------------------------------------------------------------------------

export interface OffscreenEnvelope {
  source: 'offscreen';
  payload: OffscreenToPanelMessage | CdpProxyMessage;
}

export interface PanelEnvelope {
  source: 'panel';
  payload: PanelToOffscreenMessage;
}

export interface ServiceWorkerEnvelope {
  source: 'service-worker';
  payload: CdpProxyMessage | OAuthResultMsg;
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
