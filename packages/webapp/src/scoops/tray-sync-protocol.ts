/**
 * Typed sync protocol for tray WebRTC data channels — canonical wire format.
 *
 * Leader → Follower: chat snapshots (single + chunked), streamed agent events,
 *   user-message echoes, scoop list, sprinkle list / content / updates,
 *   federated CDP (request + response + event), federated tab.open and its
 *   reply pair, federated FS (request + response), liveness (ping/pong/status/error).
 *
 * Follower → Leader: user input, abort, snapshot/scoop selection requests,
 *   sprinkle refresh + content fetch + lick, target advertisement, federated
 *   CDP (request + response + event), federated tab.open and its reply pair,
 *   federated FS (request + response), ping/pong.
 *
 * The iOS follower (`packages/ios-app/SliccFollower/Models/SyncProtocol.swift`)
 * mirrors a **subset** of this file: federated `fs.*` in both directions is
 * TS-only; iOS responds to leader-initiated `cdp.request` / `tab.open` (and
 * sends back `cdp.response` / `cdp.event` / `tab.opened`) but does NOT
 * originate either, so the follower-initiated CDP/tab.open paths are also
 * TS-only. See `docs/architecture.md` "Multi-Browser Sync (Tray) Architecture"
 * for the exact matrix and `packages/ios-app/CLAUDE.md` for the mirror-update
 * checklist.
 */

import type { MessageAttachment } from '../core/attachments.js';
import { createLogger } from '../core/logger.js';
import type { AgentEvent, ChatMessage } from '../ui/types.js';
import type { LickEvent } from './lick-manager.js';
import type { TrayDataChannelLike } from './tray-webrtc.js';

const log = createLogger('tray-sync');

/**
 * Runtime tag a cherry follower connects with (`StartPageFollowerTrayOptions.runtime`).
 * It is the advertisement-independent signal the leader uses to keep a cooperative
 * cherry host page out of flows it cannot satisfy (teleport selection) — see
 * `tray-leader-sync.ts:getBestFollowerForTeleport`. Kept here, next to the wire
 * format, because both the follower boot (`ui/`) and the leader (`scoops/`) must
 * agree on the exact string without one layer importing the other.
 */
export const CHERRY_RUNTIME_TAG = 'slicc-cherry';

// ---------------------------------------------------------------------------
// Protocol messages
// ---------------------------------------------------------------------------

export type LeaderToFollowerMessage =
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
  | { type: 'status'; scoopStatus: string }
  | { type: 'error'; error: string }
  | { type: 'scoops.list'; scoops: ScoopSummary[]; activeScoopJid: string }
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
  | { type: 'targets.registry'; targets: TrayTargetEntry[] }
  | {
      type: 'cdp.request';
      requestId: string;
      localTargetId: string;
      method: string;
      params?: Record<string, unknown>;
      sessionId?: string;
    }
  | {
      type: 'cdp.response';
      requestId: string;
      result?: Record<string, unknown>;
      error?: string;
      chunkData?: string;
      chunkIndex?: number;
      totalChunks?: number;
    }
  | { type: 'cdp.event'; method: string; params: Record<string, unknown>; sessionId?: string }
  | { type: 'tab.open'; requestId: string; url: string }
  | { type: 'tab.opened'; requestId: string; targetId: string }
  | { type: 'tab.open.error'; requestId: string; error: string }
  | { type: 'preview.open'; requestId: string; url: string }
  | { type: 'fs.request'; requestId: string; request: TrayFsRequest }
  | { type: 'fs.response'; requestId: string; response: TrayFsResponse }
  | CherrySliccEventMessage
  | { type: 'ping' }
  | { type: 'pong' };

export type FollowerToLeaderMessage =
  | { type: 'user_message'; text: string; messageId: string; attachments?: MessageAttachment[] }
  | { type: 'abort' }
  | { type: 'request_snapshot'; scoopJid?: string }
  | { type: 'scoops.select'; scoopJid: string }
  | { type: 'sprinkles.refresh' }
  | { type: 'sprinkle.fetch'; requestId: string; sprinkleName: string }
  | {
      type: 'sprinkle.lick';
      sprinkleName: string;
      body: unknown;
      targetScoop?: string;
    }
  | { type: 'lick'; event: Omit<LickEvent, 'originFollowerId' | 'originLabel'> }
  | { type: 'targets.advertise'; targets: RemoteTargetInfo[]; runtimeId: string }
  | {
      type: 'cdp.request';
      requestId: string;
      targetRuntimeId: string;
      localTargetId: string;
      method: string;
      params?: Record<string, unknown>;
      sessionId?: string;
    }
  | {
      type: 'cdp.response';
      requestId: string;
      result?: Record<string, unknown>;
      error?: string;
      chunkData?: string;
      chunkIndex?: number;
      totalChunks?: number;
    }
  | { type: 'cdp.event'; method: string; params: Record<string, unknown>; sessionId?: string }
  | { type: 'tab.open'; requestId: string; targetRuntimeId: string; url: string }
  | { type: 'tab.opened'; requestId: string; targetId: string }
  | { type: 'tab.open.error'; requestId: string; error: string }
  | { type: 'fs.request'; requestId: string; targetRuntimeId: string; request: TrayFsRequest }
  | { type: 'fs.response'; requestId: string; response: TrayFsResponse }
  | CherryHostEventMessage
  | { type: 'ping' }
  | { type: 'pong' };

// ---------------------------------------------------------------------------
// Target advertisement types
// ---------------------------------------------------------------------------

export interface RemoteTargetInfo {
  targetId: string;
  title: string;
  url: string;
  /** Distinguishes a real browser page from a cooperative cherry host page. */
  kind?: 'browser' | 'cherry';
  /**
   * Only present for kind === 'cherry'. What the host page lends to the leader,
   * expressed in the vocabulary this tray/teleport layer cares about: `network`
   * gates whether the target may serve `Network.*` CDP for teleport-pool
   * selection. NOTE: intentionally a DIFFERENT shape from the SDK handshake
   * `CherryHandshakeHello.capabilities` (`{ navigate; screenshot; openUrl }` in
   * cdp/cherry-host-protocol.ts) — `openUrl` is a sandbox-escape concern at the
   * host SDK boundary, whereas `network` is a teleport-routing concern here.
   * They are mapped, not equal.
   */
  capabilities?: { navigate: boolean; network: boolean; screenshot: boolean };
}

// ---------------------------------------------------------------------------
// Cherry event-passing messages
// ---------------------------------------------------------------------------

/** Host page → cone: a named event emitted by the cherry host page. */
export interface CherryHostEventMessage {
  type: 'cherry.host_event';
  targetId: string;
  name: string;
  detail?: unknown;
}

/** Cone → host page: a named event sent to the cherry host page. */
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

// ---------------------------------------------------------------------------
// Scoop / sprinkle summary types (for follower views)
// ---------------------------------------------------------------------------

/** Lightweight scoop description sent to followers for their scoop picker / swipe view. */
export interface ScoopSummary {
  jid: string;
  name: string;
  folder: string;
  isCone: boolean;
  assistantLabel: string;
  trigger?: string;
}

/** Lightweight sprinkle description sent to followers for the sprinkle sidebar. */
export interface SprinkleSummary {
  /** Sprinkle name (basename without .shtml). */
  name: string;
  /** Display title. */
  title: string;
  /** VFS path (used for chunked content fetch). */
  path: string;
  /** Whether this sprinkle is currently open in the leader's UI. */
  open: boolean;
  /** Whether this sprinkle should auto-open. */
  autoOpen: boolean;
}

export interface TrayTargetEntry {
  targetId: string; // Unique within the tray: "{runtimeId}:{localTargetId}"
  localTargetId: string; // The original targetId on the owning runtime
  runtimeId: string; // Which runtime owns this target
  title: string;
  url: string;
  isLocal: boolean; // True if owned by the receiving runtime (set by consumer, not registry)
  /** Distinguishes a real browser page from a cooperative cherry host page. */
  kind?: 'browser' | 'cherry';
  /**
   * Only present for kind === 'cherry'. What the host page lends to the leader,
   * expressed in the vocabulary this tray/teleport layer cares about: `network`
   * gates whether the target may serve `Network.*` CDP for teleport-pool
   * selection. NOTE: intentionally a DIFFERENT shape from the SDK handshake
   * `CherryHandshakeHello.capabilities` (`{ navigate; screenshot; openUrl }` in
   * cdp/cherry-host-protocol.ts) — `openUrl` is a sandbox-escape concern at the
   * host SDK boundary, whereas `network` is a teleport-routing concern here.
   * They are mapped, not equal.
   */
  capabilities?: { navigate: boolean; network: boolean; screenshot: boolean };
}

// ---------------------------------------------------------------------------
// Cookie teleport types
// ---------------------------------------------------------------------------

/** Chrome CDP Network.Cookie shape used for teleporting cookies between runtimes. */
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

// ---------------------------------------------------------------------------
// VFS sync protocol types
// ---------------------------------------------------------------------------

/** A single FS operation request sent over the data channel. */
export type TrayFsRequest =
  | { op: 'readFile'; path: string; encoding?: 'utf-8' | 'binary' }
  | { op: 'writeFile'; path: string; content: string; encoding: 'utf-8' | 'base64' }
  | { op: 'stat'; path: string }
  | { op: 'readDir'; path: string }
  | { op: 'mkdir'; path: string; recursive?: boolean }
  | { op: 'rm'; path: string; recursive?: boolean }
  | { op: 'exists'; path: string }
  | { op: 'walk'; path: string };

/** A single FS operation response. Chunked responses use chunkIndex/totalChunks for large file content. */
export type TrayFsResponse =
  | { ok: true; data: TrayFsResponseData; chunkIndex?: number; totalChunks?: number }
  | { ok: false; error: string; code?: string };

/** Possible data payloads for successful FS responses. */
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

// ---------------------------------------------------------------------------
// CDP response chunking helpers
// ---------------------------------------------------------------------------

/** Chunk size threshold in bytes — CDP responses larger than this are chunked. */
export const CDP_CHUNK_THRESHOLD = 64 * 1024; // 64 KB

/** Individual chunk size — smaller than threshold for safety margin. */
const CDP_CHUNK_SIZE = 32 * 1024; // 32 KB

/** Extract the CDP response message type from a union. */
type CDPResponseMessage = Extract<TraySyncMessage, { type: 'cdp.response' }>;

/**
 * Send a CDP response, automatically chunking if the serialized result exceeds CDP_CHUNK_THRESHOLD.
 * Returns true if all chunks were sent successfully, false if any send failed.
 */
export function sendCDPResponse(
  channel: { send(message: TraySyncMessage): boolean },
  requestId: string,
  result?: Record<string, unknown>,
  error?: string
): boolean {
  // Error responses are always small — send directly
  if (error || !result) {
    return channel.send({ type: 'cdp.response', requestId, result, error } as CDPResponseMessage);
  }

  const serialized = JSON.stringify(result);
  if (serialized.length <= CDP_CHUNK_THRESHOLD) {
    // Small enough — send as a single message
    return channel.send({ type: 'cdp.response', requestId, result } as CDPResponseMessage);
  }

  // Split the serialized result into chunks
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
      // Send an error response to unblock the requester (error messages are small, will fit)
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

/**
 * Reassemble chunked CDP responses. Returns the parsed result when all chunks
 * have arrived, or null if still waiting for more chunks.
 *
 * @param buffers - shared buffer map, keyed by requestId
 * @param requestId - the request ID
 * @param message - the incoming cdp.response message
 * @returns { result, error } when complete, null when still accumulating
 */
export function reassembleCDPResponse(
  buffers: Map<string, { chunks: string[]; received: number; totalChunks: number }>,
  message: CDPResponseMessage
): { result?: Record<string, unknown>; error?: string } | null {
  // Non-chunked response — return directly
  if (message.chunkIndex === undefined || message.totalChunks === undefined) {
    return { result: message.result, error: message.error };
  }

  // If this is an error during chunked transfer, abort and return error
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

  // Store the chunk (supports out-of-order delivery)
  if (!buffer.chunks[message.chunkIndex]) {
    buffer.chunks[message.chunkIndex] = message.chunkData!;
    buffer.received++;
  }

  if (buffer.received >= buffer.totalChunks) {
    buffers.delete(requestId);
    try {
      const result = JSON.parse(buffer.chunks.join('')) as Record<string, unknown>;
      return { result };
    } catch (err) {
      return {
        error: `Failed to reassemble CDP response: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return null; // Still waiting for more chunks
}

// ---------------------------------------------------------------------------
// Snapshot chunking helpers
// ---------------------------------------------------------------------------

/** Chunk size for snapshot messages — same as CDP chunk size. */
const SNAPSHOT_CHUNK_SIZE = 32 * 1024; // 32 KB

/**
 * Send a snapshot, automatically chunking if the serialized payload exceeds the chunk threshold.
 * Returns true if all chunks were sent successfully, false if any send failed.
 */
export function sendSnapshot(
  channel: { send(message: LeaderToFollowerMessage): boolean },
  messages: ChatMessage[],
  scoopJid: string
): boolean {
  const serialized = JSON.stringify({ messages, scoopJid });
  if (serialized.length <= CDP_CHUNK_THRESHOLD) {
    // Small enough — send as a single message
    return channel.send({ type: 'snapshot', messages, scoopJid });
  }

  // Split the serialized payload into chunks
  const totalChunks = Math.ceil(serialized.length / SNAPSHOT_CHUNK_SIZE);
  let allSent = true;
  for (let i = 0; i < totalChunks; i++) {
    const chunkData = serialized.slice(i * SNAPSHOT_CHUNK_SIZE, (i + 1) * SNAPSHOT_CHUNK_SIZE);
    const ok = channel.send({
      type: 'snapshot_chunk',
      chunkData,
      chunkIndex: i,
      totalChunks,
      scoopJid,
    });
    if (!ok) {
      allSent = false;
      log.error('Failed to send snapshot chunk', {
        chunkIndex: i,
        totalChunks,
        totalSize: serialized.length,
      });
      break;
    }
  }
  log.debug('Snapshot sent in chunks', { totalChunks, totalSize: serialized.length });
  return allSent;
}

/**
 * Reassemble chunked snapshot data. Returns the parsed messages and scoopJid when all chunks
 * have arrived, or null if still waiting for more chunks.
 */
export function reassembleSnapshot(
  buffer: { chunks: string[]; received: number; totalChunks: number } | null,
  message: Extract<LeaderToFollowerMessage, { type: 'snapshot_chunk' }>
):
  | { result: { messages: ChatMessage[]; scoopJid: string }; buffer: null }
  | { result: null; buffer: { chunks: string[]; received: number; totalChunks: number } } {
  if (!buffer) {
    buffer = {
      chunks: new Array(message.totalChunks),
      received: 0,
      totalChunks: message.totalChunks,
    };
  }

  // Store the chunk (supports out-of-order delivery)
  if (!buffer.chunks[message.chunkIndex]) {
    buffer.chunks[message.chunkIndex] = message.chunkData;
    buffer.received++;
  }

  if (buffer.received >= buffer.totalChunks) {
    try {
      const parsed = JSON.parse(buffer.chunks.join('')) as {
        messages: ChatMessage[];
        scoopJid: string;
      };
      return { result: parsed, buffer: null };
    } catch (err) {
      log.error('Failed to reassemble snapshot', {
        error: err instanceof Error ? err.message : String(err),
      });
      return { result: { messages: [], scoopJid: message.scoopJid }, buffer: null };
    }
  }

  return { result: null, buffer }; // Still waiting for more chunks
}

// ---------------------------------------------------------------------------
// TraySyncChannel — typed send/receive wrapper around TrayDataChannelLike
// ---------------------------------------------------------------------------

export class TraySyncChannel<
  TSend extends TraySyncMessage = TraySyncMessage,
  TReceive extends TraySyncMessage = TraySyncMessage,
> {
  private readonly listeners: Array<(message: TReceive) => void> = [];
  private closed = false;

  constructor(private readonly channel: TrayDataChannelLike) {
    this.channel.addEventListener('message', (event: { data: string }) => {
      if (this.closed) return;
      try {
        const parsed = JSON.parse(event.data) as TReceive;
        for (const listener of this.listeners) {
          listener(parsed);
        }
      } catch (error) {
        log.warn('Failed to parse tray sync message', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  /** Send a message. Returns true if sent successfully, false if send failed. */
  send(message: TSend): boolean {
    if (this.closed) return false;
    try {
      this.channel.send(JSON.stringify(message));
      return true;
    } catch (error) {
      log.error('Failed to send tray sync message', {
        type: (message as { type: string }).type,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  onMessage(callback: (message: TReceive) => void): () => void {
    this.listeners.push(callback);
    return () => {
      const index = this.listeners.indexOf(callback);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  close(): void {
    this.closed = true;
    this.listeners.length = 0;
    this.channel.close();
  }

  get isOpen(): boolean {
    return !this.closed && this.channel.readyState === 'open';
  }
}

// ---------------------------------------------------------------------------
// Typed factory helpers
// ---------------------------------------------------------------------------

export function createLeaderSyncChannel(
  channel: TrayDataChannelLike
): TraySyncChannel<LeaderToFollowerMessage, FollowerToLeaderMessage> {
  return new TraySyncChannel(channel);
}

export function createFollowerSyncChannel(
  channel: TrayDataChannelLike
): TraySyncChannel<FollowerToLeaderMessage, LeaderToFollowerMessage> {
  return new TraySyncChannel(channel);
}
