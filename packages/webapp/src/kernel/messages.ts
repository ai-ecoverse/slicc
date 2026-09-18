import {
  type CDPPayload,
  type ComputerDescriptor,
  type ComputerInputEvent,
  isExtensionMessage as isExtensionMessageEnvelope,
  type ToolProgressEvent,
  type WebhookDeliveryDisposition,
} from '@slicc/shared-ts';
import type { MessageAttachment } from '../core/attachments.js';
import type { AgentSpawnOptions, AgentSpawnResult } from '../scoops/agent-bridge.js';
import type { ChatMessage } from '../scoops/chat-types.js';
import type { ScoopTabState } from '../scoops/types.js';
import type { TerminalControlMsg, TerminalEventMsg } from '../shell/terminal-protocol.js';
import type { SudoDecision, SudoRequest, TurnGuestGate } from '../sudo/types.js';

export interface SprinkleSummaryEnvelope {
  name: string;
  title: string;
  path: string;
  open: boolean;
  autoOpen: boolean;
  icon?: string;
}

export interface ForwardedLickEvent {
  type: string;
  timestamp: string;
  body: unknown;
  [key: string]: unknown;
}

export interface UserMessageMsg {
  type: 'user-message';
  scoopJid: string;
  text: string;
  messageId: string;
  attachments?: MessageAttachment[];

  steer?: boolean;

  guestGate?: TurnGuestGate;
}

export interface ConeCreateMsg {
  type: 'cone-create';
  name: string;

  description?: string;

  prompt?: string;

  model?: ScoopModelSelection;
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

export interface RequestScoopMessagesMsg {
  type: 'request-scoop-messages';
  scoopJid: string;
}

export interface RequestScoopTranscriptMsg {
  type: 'request-scoop-transcript';
  requestId: string;
  scoopJid: string;
}

export interface ScoopTranscriptMsg {
  type: 'scoop-transcript';
  requestId: string;
  scoopJid: string;
  transcript: string;
}

export interface RequestScoopChatMessagesMsg {
  type: 'request-scoop-chat-messages';
  requestId: string;
  scoopJid: string;
}

export interface ScoopChatMessagesMsg {
  type: 'scoop-chat-messages';
  requestId: string;
  scoopJid: string;
  messages: ScoopMessagesReplacedMsg['messages'];
}

export interface RequestSessionStatsMsg {
  type: 'request-session-stats';
  requestId: string;
}

export interface RequestSudoApprovalMsg {
  type: 'request-sudo-approval';
  requestId: string;
  request: SudoRequest;
}

export interface SudoApprovalMsg {
  type: 'sudo-approval';
  requestId: string;
  decision: SudoDecision;
}

export interface SessionStatsMsg {
  type: 'session-stats';
  requestId: string;

  totalCost: number;

  burnRate: number;

  fills: Array<{ jid: string; fill: number }>;

  models: Array<{ model: string; cost: number; turns: number; tokens: number }>;

  scoops: Array<{
    name: string;
    model: string;
    cost: number;
    type: 'cone' | 'scoop';
    source: 'live' | 'dropped' | 'frozen';
  }>;

  budget?: SessionBudgetWindow;
}

export interface SessionBudgetWindow {
  percent: number;
  status: 'ok' | 'rate-limited';

  window: string;

  resetsAt?: string;

  providerId?: string;
}

export interface ClearChatMsg {
  type: 'clear-chat';

  requestId: string;

  scoopJid?: string;

  discardLiveSnapshot?: boolean;
}

export interface ClearChatAckMsg {
  type: 'clear-chat-ack';
  requestId: string;
}

export interface AgentSpawnRequestMsg {
  type: 'agent-spawn-request';
  requestId: string;
  options: AgentSpawnOptions;
}

export interface AgentSpawnAbortMsg {
  type: 'agent-spawn-abort';
  requestId: string;
}

export type AgentSpawnResultMsg =
  | { type: 'agent-spawn-result'; requestId: string; ok: true; result: AgentSpawnResult }
  | { type: 'agent-spawn-result'; requestId: string; ok: false; error: string };

export interface ClearFilesystemMsg {
  type: 'clear-filesystem';
}

export interface RefreshModelMsg {
  type: 'refresh-model';
}

export interface ScoopModelSelection {
  provider: string;
  id: string;
}

export interface SetScoopModelMsg {
  type: 'set-scoop-model';

  requestId?: string;
  scoopJid: string;

  model?: ScoopModelSelection;
}

export interface SetScoopModelAckMsg {
  type: 'set-scoop-model-ack';
  requestId: string;
  scoopJid: string;
  model?: ScoopModelSelection;

  applied: boolean;
}

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

  requestId?: string;
  scoopJid: string;

  level?: ExtensionThinkingLevel;

  effortOverride?: string;
}

export interface SetThinkingLevelAckMsg {
  type: 'set-thinking-level-ack';
  requestId: string;
  scoopJid: string;
  level?: ExtensionThinkingLevel;
  effortOverride?: string;
  applied: boolean;
}

export interface PanelCdpCommandMsg {
  type: 'panel-cdp-command';
  id: number;
  method: string;
  params?: CDPPayload;
  sessionId?: string;
}

export interface OAuthRequestMsg {
  type: 'oauth-request';
  providerId: string;
  authorizeUrl: string;

  interactive?: boolean;
}

export interface SprinkleLickOrigin {
  label?: string;

  unitJid?: string;
}

export interface SprinkleLickMsg {
  type: 'sprinkle-lick';
  sprinkleName: string;
  body: unknown;

  targetScoop?: string;

  origin?: SprinkleLickOrigin;
}

export interface FollowerSprinkleFetchRequestMsg {
  type: 'follower-sprinkle-fetch';
  id: string;
  sprinkleName: string;
}

export interface FollowerSprinkleFetchCancelMsg {
  type: 'follower-sprinkle-fetch-cancel';
  sprinkleName: string;
}

export interface FollowerSprinkleLickMsg {
  type: 'follower-sprinkle-lick';
  sprinkleName: string;
  body: unknown;
  targetScoop?: string;
}

export interface WebhookEventMsg {
  type: 'lick-webhook-event';
  webhookId: string;
  headers: Record<string, string>;
  body: unknown;

  requestId?: string;
}

export interface WebhookDeliveryMsg {
  type: 'lick-webhook-delivery';
  requestId: string;
  disposition: WebhookDeliveryDisposition;
}

export interface SetFollowerForwardingMsg {
  type: 'set-follower-forwarding';
  enabled: boolean;
}

export interface InjectForwardedLickMsg {
  type: 'inject-forwarded-lick';
  event: ForwardedLickEvent;
}

export interface ForwardLickMsg {
  type: 'forward-lick';
  event: ForwardedLickEvent;
}

export interface CherryHostEventMsg {
  type: 'lick-cherry-host-event';
  cherryRuntimeId: string | undefined;
  name: string;
  detail?: unknown;
}

export interface PreviewLickMsg {
  type: 'lick-preview';
  event: ForwardedLickEvent;
}

export interface ReloadSkillsMsg {
  type: 'reload-skills';
}

export interface ToolUIActionMsg {
  type: 'tool-ui-action';
  requestId: string;
  action: string;
  data?: unknown;
}

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

export interface VfsDirEntryEnvelope {
  name: string;
  type: 'file' | 'directory' | 'symlink';
  size?: number;

  mtime?: number;

  ctime?: number;
  ino?: number;
  uid?: number;
  gid?: number;

  mode?: number;
}

export interface VfsStatsEnvelope {
  type: 'file' | 'directory' | 'symlink';
  size: number;
  mtime: number;
  ctime: number;
  isSymlink?: boolean;
  symlinkTarget?: string;
}

export interface VfsErrorEnvelope {
  code: string;
  message: string;
  path?: string;
}

export interface VfsReadDirRequestMsg {
  type: 'vfs-read-dir';

  requestId: string;
  path: string;

  includeStats?: boolean;
}

export interface VfsReadFileRequestMsg {
  type: 'vfs-read-file';

  requestId: string;
  path: string;

  encoding?: 'utf-8' | 'binary';

  start?: number;
  end?: number;
}

export interface VfsStatRequestMsg {
  type: 'vfs-stat';

  requestId: string;
  path: string;
}

export type VfsReadRequestMsg = VfsReadDirRequestMsg | VfsReadFileRequestMsg | VfsStatRequestMsg;

export type VfsReadDirResultMsg =
  | { type: 'vfs-read-dir-result'; requestId: string; ok: true; entries: VfsDirEntryEnvelope[] }
  | { type: 'vfs-read-dir-result'; requestId: string; ok: false; error: VfsErrorEnvelope };

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

export type VfsStatResultMsg =
  | { type: 'vfs-stat-result'; requestId: string; ok: true; stats: VfsStatsEnvelope }
  | { type: 'vfs-stat-result'; requestId: string; ok: false; error: VfsErrorEnvelope };

export type VfsReadResultMsg = VfsReadDirResultMsg | VfsReadFileResultMsg | VfsStatResultMsg;

export type VfsWriteFileRequestMsg =
  | {
      type: 'vfs-write-file';

      requestId: string;
      path: string;
      encoding: 'utf-8';
      data: string;

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

export interface VfsMkdirRequestMsg {
  type: 'vfs-mkdir';

  requestId: string;
  path: string;

  recursive?: boolean;
}

export interface VfsRmRequestMsg {
  type: 'vfs-rm';

  requestId: string;
  path: string;

  recursive?: boolean;
}

export interface VfsFlushRequestMsg {
  type: 'vfs-flush';

  requestId: string;
}

export interface VfsListMountPointsRequestMsg {
  type: 'vfs-list-mount-points';

  requestId: string;
}

export interface VfsMountPointEnvelope {
  path: string;
  kind: 'local' | 'hostfs' | 's3' | 'da' | 'aem' | 'proc';
}

export type VfsWriteRequestMsg =
  | VfsWriteFileRequestMsg
  | VfsMkdirRequestMsg
  | VfsRmRequestMsg
  | VfsFlushRequestMsg
  | VfsListMountPointsRequestMsg;

export type VfsWriteFileResultMsg =
  | { type: 'vfs-write-file-result'; requestId: string; ok: true }
  | { type: 'vfs-write-file-result'; requestId: string; ok: false; error: VfsErrorEnvelope };

export type VfsMkdirResultMsg =
  | { type: 'vfs-mkdir-result'; requestId: string; ok: true }
  | { type: 'vfs-mkdir-result'; requestId: string; ok: false; error: VfsErrorEnvelope };

export type VfsRmResultMsg =
  | { type: 'vfs-rm-result'; requestId: string; ok: true }
  | { type: 'vfs-rm-result'; requestId: string; ok: false; error: VfsErrorEnvelope };

export type VfsFlushResultMsg =
  | { type: 'vfs-flush-result'; requestId: string; ok: true }
  | { type: 'vfs-flush-result'; requestId: string; ok: false; error: VfsErrorEnvelope };

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

export interface VfsChangeEventEnvelope {
  type: 'create' | 'modify' | 'delete';
  path: string;
  entryType?: 'file' | 'directory' | 'symlink';
}

export interface VfsWatchRequestMsg {
  type: 'vfs-watch';

  subscriptionId: string;
  basePaths: string[];
}

export interface VfsUnwatchRequestMsg {
  type: 'vfs-unwatch';
  subscriptionId: string;
}

export type VfsWatchControlMsg = VfsWatchRequestMsg | VfsUnwatchRequestMsg;

export type VfsWatchResultMsg =
  | { type: 'vfs-watch-result'; subscriptionId: string; ok: true }
  | { type: 'vfs-watch-result'; subscriptionId: string; ok: false; error: VfsErrorEnvelope };

export interface VfsWatchEventMsg {
  type: 'vfs-watch-event';
  subscriptionId: string;
  events: VfsChangeEventEnvelope[];
}

export type VfsWatchPushMsg = VfsWatchResultMsg | VfsWatchEventMsg;

export interface ComputersListMsg {
  type: 'computers';
  computers: ComputerDescriptor[];
}

export interface ComputerFrameMsg {
  type: 'computer-frame';
  id: string;
  seq: number;
  mime: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
  bytes: Uint8Array;
  overCap?: boolean;
}

export interface ComputerWatchMsg {
  type: 'computer-watch';
  id: string;
  fps: number;
  maxWidth: number;
}

export interface ComputerUnwatchMsg {
  type: 'computer-unwatch';
  id: string;
}

export interface ComputerInputMsg {
  type: 'computer-input';
  id: string;
  events: ComputerInputEvent[];
}

export type ComputerWatchControlMsg = ComputerWatchMsg | ComputerUnwatchMsg;

export type ComputerPageControlMsg = ComputerWatchControlMsg | ComputerInputMsg;

export const DETACHED_RUNTIME_QUERY_NAME = 'detached';

export { LEADER_EXT_ID_QUERY_NAME } from '@slicc/shared-ts';

export {
  LEADER_RUNTIME_QUERY_NAME,
  LEADER_RUNTIME_QUERY_VALUE,
} from '../base/leader-runtime-query.js';

export interface DetachedPopoutRequestMsg {
  type: 'detached-popout-request';
}

export interface DetachedClaimMsg {
  type: 'detached-claim';
}

export interface DetachedActiveMsg {
  type: 'detached-active';
}

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
  | RequestSudoApprovalMsg
  | ClearChatMsg
  | AgentSpawnRequestMsg
  | AgentSpawnAbortMsg
  | ClearFilesystemMsg
  | RefreshModelMsg
  | SetScoopModelMsg
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
  | TerminalControlMsg
  | VfsReadRequestMsg
  | VfsWriteRequestMsg
  | VfsWatchControlMsg
  | ComputerWatchControlMsg
  | ComputerInputMsg
  | DetachedPopoutRequestMsg
  | DetachedClaimMsg;

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
    | 'tool_ui_done'
    | 'tool_progress';
  text?: string;

  progress?: ToolProgressEvent;

  toolCallId?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: string;
  isError?: boolean;
  requestId?: string;
  html?: string;
  model?: string;
  usage?: ChatMessage['usage'];

  displayScoopJid?: string;
}

export interface ScoopStatusMsg {
  type: 'scoop-status';
  scoopJid: string;
  status: ScoopTabState['status'];
}

export interface CompactionStateMsg {
  type: 'compaction-state';
  scoopJid: string;

  state: 'summarizing' | 'extracting-memory' | 'fallback' | 'cancelled' | 'idle';

  trigger?: 'threshold' | 'overflow' | 'idle';

  transcriptPath?: string;

  failure?:
    | 'rate-limit'
    | 'quota-exhausted'
    | 'authentication'
    | 'provider-unavailable'
    | 'empty-response'
    | 'invalid-response'
    | 'context-too-large'
    | 'unknown';

  roundId?: string;

  rowId?: string;
}

export interface ScoopSnapshotConfig {
  modelId?: string;

  modelProviderId?: string;
  thinkingLevel?: ExtensionThinkingLevel;

  effortOverride?: string;
}

export interface ScoopListMsg {
  type: 'scoop-list';
  scoops: Array<{
    jid: string;
    name: string;
    folder: string;

    parentId: string | null;
    assistantLabel: string;
    status: ScoopTabState['status'];

    config?: ScoopSnapshotConfig;
  }>;
}

export interface StateSnapshotMsg {
  type: 'state-snapshot';
  scoops: ScoopListMsg['scoops'];
  activeScoopJid: string | null;

  trayRuntimeStatus?: { leader: TrayLeaderStatusSnapshot; follower: TrayFollowerStatusSnapshot };
}

export interface ErrorMsg {
  type: 'error';
  scoopJid: string;
  error: string;

  endTurn?: boolean;
}

export interface LickBackpressureMsg {
  type: 'lick-backpressure';
  scoopJid: string;
  count: number;
  waitingMs: number;
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

    lickId?: string;

    lickState?: 'pending' | 'confirmed' | 'dismissed';
  };
}

export interface MessageUpdatedMsg {
  type: 'message-updated';
  scoopJid: string;
  messageId: string;
  lickId?: string;
  lickState?: 'pending' | 'confirmed' | 'dismissed';
}

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
    model?: string;
    usage?: ChatMessage['usage'];

    compaction?: ChatMessage['compaction'];

    error?: boolean;

    lickId?: string;

    lickState?: 'pending' | 'confirmed' | 'dismissed';
  }>;

  queuedIds?: string[];
}

export interface OffscreenReadyMsg {
  type: 'offscreen-ready';
}

export interface TrayRuntimeStatusMsg {
  type: 'tray-runtime-status';
  leader: TrayLeaderStatusSnapshot;
  follower: TrayFollowerStatusSnapshot;
}

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
  result?: CDPPayload;
  error?: string;
}

export interface OAuthResultMsg {
  type: 'oauth-result';
  providerId: string;
  code?: string;
  state?: string;
  error?: string;

  redirectUrl?: string;
}

export interface NavigateLickMsg {
  type: 'navigate-lick';

  url: string;

  verb: 'handoff' | 'upskill';

  target: string;

  instruction?: string;

  branch?: string;

  path?: string;

  title?: string;
  tabId?: number;
}

export interface FollowerSprinklesListMsg {
  type: 'follower-sprinkles-list';
  sprinkles: SprinkleSummaryEnvelope[];
}

export interface FollowerSprinkleUpdateMsg {
  type: 'follower-sprinkle-update';
  sprinkleName: string;
  data: unknown;
}

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
  | LickBackpressureMsg
  | ScoopCreatedMsg
  | IncomingMessageMsg
  | MessageUpdatedMsg
  | ScoopMessagesReplacedMsg
  | ScoopTranscriptMsg
  | ScoopChatMessagesMsg
  | SessionStatsMsg
  | SudoApprovalMsg
  | PanelCdpResponseMsg
  | OAuthResultMsg
  | TrayRuntimeStatusMsg
  | ClearChatAckMsg
  | WebhookDeliveryMsg
  | AgentSpawnResultMsg
  | SetScoopModelAckMsg
  | SetThinkingLevelAckMsg
  | FollowerSprinklesListMsg
  | FollowerSprinkleUpdateMsg
  | FollowerSprinkleFetchResultMsg
  | ForwardLickMsg
  | TerminalEventMsg
  | VfsReadResultMsg
  | VfsWriteResultMsg
  | VfsWatchPushMsg
  | ComputersListMsg
  | ComputerFrameMsg;

export interface CdpCommandMsg {
  type: 'cdp-command';
  id: number;
  method: string;
  params?: CDPPayload;
  sessionId?: string;
}

export interface CdpResponseMsg {
  type: 'cdp-response';
  id: number;
  result?: CDPPayload;
  error?: string;
}

export interface CdpEventMsg {
  type: 'cdp-event';
  method: string;
  params?: CDPPayload;
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

export function isExtensionMessage(msg: unknown): msg is ExtensionMessage {
  return isExtensionMessageEnvelope(msg);
}
