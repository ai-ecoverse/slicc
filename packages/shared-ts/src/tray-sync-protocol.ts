import type { AgentEvent, ChatMessage, LickEvent, MessageAttachment } from './agent-wire-types.js';
import type { TranscriptExportErrorCode } from './transcript-export.js';

export const CHERRY_RUNTIME_TAG = 'slicc-cherry';

export const TRAY_SYNC_PROTOCOL_VERSION = 8;

// biome-ignore lint/plugin: CDP params/result are per-method and open-ended; the tray relays them without inspecting fields.
export type CDPPayload = Record<string, unknown>;

export type TranscriptExportSelector = { kind: 'active' } | { kind: 'frozen'; sessionId: string };

export interface TraySyncHelloMessage {
  type: 'hello';
  protocolVersion: number;

  runtime?: string;

  capabilities?: TraySyncCapabilities;

  motd?: string;
}

export interface TraySyncCapabilities {
  exec?: boolean;

  browser?: boolean;

  oauthPopup?: boolean;

  sudoApproval?: boolean;

  biometric?: boolean;
}

export type TraySudoKind =
  | 'command'
  | 'read'
  | 'write'
  | 'secret'
  | 'export'
  | 'guest-message'
  | 'guest-tool';

export type TraySudoDecision = 'allow' | 'deny' | 'always';

export type TraySudoAttestation = 'biometric' | 'passcode' | 'none';

export const TRAY_CHUNK_FRAME_TYPE = '__chunk';

export interface TrayChunkFrame {
  type: typeof TRAY_CHUNK_FRAME_TYPE;

  chunkId: string;

  chunkIndex: number;

  totalChunks: number;

  chunkData: string;
}

export const TRAY_DEFAULT_MAX_MESSAGE_BYTES = 65536;

export const TRAY_MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

export const TRAY_SEND_HIGH_WATER_BYTES = 8 * 1024 * 1024;

export const TRAY_MAX_CHUNK_COUNT = 8192;

export const TRAY_MAX_PENDING_REASSEMBLIES = 8;

export const TRAY_MAX_REASSEMBLY_BYTES = 32 * 1024 * 1024;

export function isTrayChunkFrame(value: unknown): value is TrayChunkFrame {
  if (typeof value !== 'object' || value === null) return false;
  const frame = value as Partial<TrayChunkFrame>;
  return (
    frame.type === TRAY_CHUNK_FRAME_TYPE &&
    typeof frame.chunkId === 'string' &&
    typeof frame.chunkIndex === 'number' &&
    typeof frame.totalChunks === 'number' &&
    typeof frame.chunkData === 'string' &&
    Number.isInteger(frame.chunkIndex) &&
    Number.isInteger(frame.totalChunks) &&
    frame.totalChunks > 0 &&
    frame.totalChunks <= TRAY_MAX_CHUNK_COUNT &&
    frame.chunkIndex >= 0 &&
    frame.chunkIndex < frame.totalChunks
  );
}

export type LeaderToFollowerMessage =
  | { type: 'transcript.export.pending'; requestId: string }
  | {
      type: 'biscotto.message.state';
      messageId: string;
      state: 'pending' | 'approved' | 'rejected' | 'unanswered';
    }
  | { type: 'transcript.export.denied'; requestId: string }
  | {
      type: 'sudo.approve.request';
      requestId: string;
      kind: TraySudoKind;
      detail: string;

      requester?: string;
      suggestedPattern?: string;

      scoopName?: string;
      expiresAt: number;
    }
  | { type: 'sudo.approve.cancel'; requestId: string }
  | {
      type: 'transcript.export.start';
      requestId: string;
      filename: string;
      estimatedBytes?: number;
    }
  | { type: 'transcript.export.chunk'; requestId: string; index: number; data: string }
  | {
      type: 'transcript.export.complete';
      requestId: string;
      chunks: number;
      byteLength: number;
      sha256: string;
    }
  | { type: 'transcript.export.error'; requestId: string; code: TranscriptExportErrorCode }
  | { type: 'snapshot'; messages: ChatMessage[]; scoopJid: string }
  | {
      type: 'snapshot_chunk';
      chunkData: string;
      chunkIndex: number;
      totalChunks: number;
      scoopJid: string;
    }
  | { type: 'agent_event'; event: AgentEvent; scoopJid: string }
  | {
      type: 'user_message_echo';
      text: string;
      messageId: string;
      scoopJid: string;
      attachments?: MessageAttachment[];
    }
  | { type: 'status'; scoopStatus: string; scoopJid: string }
  | { type: 'error'; error: string }
  | { type: 'scoops.list'; scoops: ScoopSummary[]; activeScoopJid: string }
  | { type: 'models.list'; models: TrayModelCatalogEntry[] }
  | { type: 'model.state'; state: TrayModelSelectionState }
  | { type: 'sprinkles.list'; sprinkles: SprinkleSummary[] }
  | {
      type: 'sprinkle.content';
      requestId: string;
      sprinkleName: string;
      content: string;
      chunkIndex?: number;
      totalChunks?: number;
      error?: string;
    }
  | { type: 'sprinkle.update'; sprinkleName: string; data: unknown }
  | { type: 'sprinkle.reloaded'; sprinkleName: string }
  | { type: 'targets.registry'; targets: TrayTargetEntry[] }
  | {
      type: 'cdp.request';
      requestId: string;
      localTargetId: string;
      method: string;
      params?: CDPPayload;
      sessionId?: string;
    }
  | {
      type: 'cdp.response';
      requestId: string;
      result?: CDPPayload;
      error?: string;
      chunkData?: string;
      chunkIndex?: number;
      totalChunks?: number;
    }
  | { type: 'cdp.event'; method: string; params: CDPPayload; sessionId?: string }
  | { type: 'tab.open'; requestId: string; url: string }
  | { type: 'tab.opened'; requestId: string; targetId: string }
  | { type: 'tab.open.error'; requestId: string; error: string }
  | { type: 'oauth.popup.request'; requestId: string; url: string }
  | { type: 'preview.open'; requestId: string; url: string }
  | { type: 'fs.request'; requestId: string; request: TrayFsRequest }
  | { type: 'fs.response'; requestId: string; response: TrayFsResponse }
  | TrayExecRequestMessage
  | TrayExecChunkMessage
  | TrayExecResponseMessage
  | TrayExecSignalMessage
  | CherrySliccEventMessage
  | { type: 'theme.apply'; themeJson: string | null }
  | TraySyncHelloMessage
  | { type: 'ping' }
  | { type: 'pong' };

export type FollowerToLeaderMessage =
  | { type: 'transcript.export.request'; requestId: string; selector: TranscriptExportSelector }
  | { type: 'transcript.export.cancel'; requestId: string }
  | { type: 'transcript.export.ack'; requestId: string; index: number }
  | {
      type: 'sudo.approve.response';
      requestId: string;
      decision: TraySudoDecision;
      pattern?: string;
      attestation?: TraySudoAttestation;
    }
  | {
      type: 'push.register';
      platform: 'ios';
      token: string;
      environment: 'sandbox' | 'production';
    }
  | {
      type: 'user_message';
      text: string;
      messageId: string;
      attachments?: MessageAttachment[];

      steer?: boolean;
    }
  | { type: 'abort' }
  | { type: 'new_session'; action: 'save' | 'skip' | 'erase' }
  | { type: 'request_snapshot'; scoopJid?: string }
  | { type: 'scoops.select'; scoopJid: string }
  | { type: 'models.request' }
  | {
      type: 'model.select';
      modelId: string;

      scoopJid?: string;
    }
  | {
      type: 'thinking.set';
      scoopJid: string;
      thinkingLevel: TrayThinkingLevel;
      effortOverride?: string;
    }
  | { type: 'sprinkles.refresh' }
  | { type: 'sprinkle.fetch'; requestId: string; sprinkleName: string }
  | {
      type: 'sprinkle.lick';
      sprinkleName: string;
      body: unknown;
      targetScoop?: string;
    }
  | { type: 'sprinkle.instances'; sprinkles: string[] }
  | { type: 'lick'; event: Omit<LickEvent, 'originFollowerId' | 'originLabel'> }
  | { type: 'targets.advertise'; targets: RemoteTargetInfo[]; runtimeId: string }
  | {
      type: 'cdp.request';
      requestId: string;
      targetRuntimeId: string;
      localTargetId: string;
      method: string;
      params?: CDPPayload;
      sessionId?: string;
    }
  | {
      type: 'cdp.response';
      requestId: string;
      result?: CDPPayload;
      error?: string;
      chunkData?: string;
      chunkIndex?: number;
      totalChunks?: number;
    }
  | { type: 'cdp.event'; method: string; params: CDPPayload; sessionId?: string }
  | { type: 'tab.open'; requestId: string; targetRuntimeId: string; url: string }
  | { type: 'tab.opened'; requestId: string; targetId: string }
  | { type: 'tab.open.error'; requestId: string; error: string }
  | { type: 'tab.teleport.request'; requestId: string; targetId: string }
  | { type: 'oauth.popup.response'; requestId: string; redirectUrl?: string; error?: string }
  | { type: 'fs.request'; requestId: string; targetRuntimeId: string; request: TrayFsRequest }
  | { type: 'fs.response'; requestId: string; response: TrayFsResponse }
  | TrayExecRequestMessage
  | TrayExecChunkMessage
  | TrayExecResponseMessage
  | TrayExecSignalMessage
  | CherryHostEventMessage
  | TraySyncHelloMessage
  | { type: 'ping' }
  | { type: 'pong' };

export interface RemoteTargetInfo {
  targetId: string;
  title: string;
  url: string;

  kind?: 'browser' | 'cherry' | 'preview';

  capabilities?: { navigate: boolean; network: boolean; screenshot: boolean };
}

export interface CherryHostEventMessage {
  type: 'cherry.host_event';
  targetId: string;
  name: string;
  detail?: unknown;
}

export interface CherrySliccEventMessage {
  type: 'cherry.slicc_event';
  targetId: string;
  name: string;
  detail?: unknown;
}

export function isCherryHostEventMessage(m: unknown): m is CherryHostEventMessage {
  return (
    typeof m === 'object' && m !== null && (m as { type?: string }).type === 'cherry.host_event'
  );
}

export function isCherrySliccEventMessage(m: unknown): m is CherrySliccEventMessage {
  return (
    typeof m === 'object' && m !== null && (m as { type?: string }).type === 'cherry.slicc_event'
  );
}

export const TRAY_MAX_OPEN_CALLBACK_PARAM_COUNT = 16;

export const TRAY_MAX_OPEN_CALLBACK_BYTES = 16 * 1024;

export interface TrayExecRequestMessage {
  type: 'exec.request';
  requestId: string;

  command: string;

  cwd?: string;

  env?: Record<string, string>;

  stdin?: string;
}

export interface TrayExecChunkMessage {
  type: 'exec.chunk';
  requestId: string;
  stream: 'stdout' | 'stderr';

  data: string;
}

export interface TrayExecResponseMessage {
  type: 'exec.response';
  requestId: string;
  exitCode: number;

  signal?: string;

  error?: string;
}

export interface TrayExecSignalMessage {
  type: 'exec.signal';
  requestId: string;
  signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL';
}

export type TrayThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface TrayModelCatalogEntry {
  providerName: string;
  modelId: string;
  modelName: string;
  reasoning: boolean;
}

export interface TrayModelSelectionState {
  activeModelId: string;
  scoopJid: string;
  thinkingLevel?: TrayThinkingLevel;
  effortOverride?: string;
}

export interface ScoopSummary {
  jid: string;
  name: string;
  folder: string;

  isCone?: boolean;

  parentId?: string | null;
  assistantLabel: string;

  addedAt?: string;
  trigger?: string;

  state?: 'working' | 'broken' | 'initializing' | 'idle';

  activity?: 'thinking' | 'tool' | 'awaiting';

  fill?: number;

  turns?: number;

  model?: ScoopSummaryModel;
}

export interface ScoopSummaryModel {
  provider: string;

  id: string;
}

export interface SprinkleSummary {
  name: string;

  title: string;

  path: string;

  open: boolean;

  autoOpen: boolean;

  icon?: string;
}

export interface TrayTargetEntry {
  targetId: string;
  localTargetId: string;
  runtimeId: string;
  title: string;
  url: string;
  isLocal: boolean;

  kind?: 'browser' | 'cherry' | 'preview';

  capabilities?: { navigate: boolean; network: boolean; screenshot: boolean };
}

export interface CookieTeleportCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  size: number;
  httpOnly: boolean;
  secure: boolean;
  session: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  priority?: 'Low' | 'Medium' | 'High';
  sameParty?: boolean;
  sourceScheme?: 'Unset' | 'NonSecure' | 'Secure';
  sourcePort?: number;
  partitionKey?: string;
}

export type TrayFsRequest =
  | { op: 'readFile'; path: string; encoding?: 'utf-8' | 'binary' }
  | { op: 'writeFile'; path: string; content: string; encoding: 'utf-8' | 'base64' }
  | { op: 'stat'; path: string }
  | { op: 'readDir'; path: string }
  | { op: 'mkdir'; path: string; recursive?: boolean }
  | { op: 'rm'; path: string; recursive?: boolean }
  | { op: 'exists'; path: string }
  | { op: 'walk'; path: string };

export type TrayFsResponse =
  | { ok: true; data: TrayFsResponseData; chunkIndex?: number; totalChunks?: number }
  | { ok: false; error: string; code?: string };

export type TrayFsResponseData =
  | { type: 'file'; content: string; encoding: 'utf-8' | 'base64' }
  | {
      type: 'stat';
      stat: {
        type: 'file' | 'directory' | 'symlink';
        size: number;
        mtime: number;
        ctime: number;
      };
    }
  | {
      type: 'dirEntries';
      entries: Array<{ name: string; type: 'file' | 'directory' | 'symlink' }>;
    }
  | { type: 'exists'; exists: boolean }
  | { type: 'paths'; paths: string[] }
  | { type: 'void' };

export type TraySyncMessage = LeaderToFollowerMessage | FollowerToLeaderMessage;

export function unhandledProtocolMessage(message: never): { type?: string } {
  return message as { type?: string };
}

export const CDP_CHUNK_THRESHOLD = 64 * 1024;

const CDP_CHUNK_SIZE = 32 * 1024;

type CDPResponseMessage = Extract<TraySyncMessage, { type: 'cdp.response' }>;

export function sendCDPResponse(
  channel: { send(message: TraySyncMessage): boolean },
  requestId: string,
  result?: CDPPayload,
  error?: string
): boolean {
  if (error || !result) {
    return channel.send({ type: 'cdp.response', requestId, result, error } as CDPResponseMessage);
  }

  const serialized = JSON.stringify(result);
  if (serialized.length <= CDP_CHUNK_THRESHOLD) {
    return channel.send({ type: 'cdp.response', requestId, result } as CDPResponseMessage);
  }

  const totalChunks = Math.ceil(serialized.length / CDP_CHUNK_SIZE);
  let allSent = true;
  for (let i = 0; i < totalChunks; i++) {
    const chunkData = serialized.slice(i * CDP_CHUNK_SIZE, (i + 1) * CDP_CHUNK_SIZE);
    const ok = channel.send({
      type: 'cdp.response',
      requestId,
      chunkData,
      chunkIndex: i,
      totalChunks,
    } as CDPResponseMessage);
    if (!ok) {
      allSent = false;

      channel.send({
        type: 'cdp.response',
        requestId,
        error: `Failed to send CDP response chunk ${i}/${totalChunks} (response was ${serialized.length} bytes)`,
      } as CDPResponseMessage);
      break;
    }
  }
  return allSent;
}

export function reassembleCDPResponse(
  buffers: Map<string, { chunks: string[]; received: number; totalChunks: number }>,
  message: CDPResponseMessage
): { result?: CDPPayload; error?: string } | null {
  if (message.chunkIndex === undefined || message.totalChunks === undefined) {
    return { result: message.result, error: message.error };
  }

  if (message.error) {
    buffers.delete(message.requestId);
    return { error: message.error };
  }

  const requestId = message.requestId;
  let buffer = buffers.get(requestId);
  if (!buffer) {
    buffer = {
      chunks: new Array(message.totalChunks),
      received: 0,
      totalChunks: message.totalChunks,
    };
    buffers.set(requestId, buffer);
  }

  if (!buffer.chunks[message.chunkIndex]) {
    buffer.chunks[message.chunkIndex] = message.chunkData!;
    buffer.received++;
  }

  if (buffer.received >= buffer.totalChunks) {
    buffers.delete(requestId);
    try {
      const result = JSON.parse(buffer.chunks.join('')) as CDPPayload;
      return { result };
    } catch (err) {
      return {
        error: `Failed to reassemble CDP response: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return null;
}
