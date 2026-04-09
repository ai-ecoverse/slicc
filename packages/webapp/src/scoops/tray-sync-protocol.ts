/**
 * Typed sync protocol for tray WebRTC data channels.
 *
 * Leader → Follower: snapshots of chat state + real-time agent events.
 * Follower → Leader: user input + abort requests.
 */

import type { AgentEvent, ChatMessage } from '../ui/types.js';
import type { TrayDataChannelLike } from './tray-webrtc.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('tray-sync');

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
  | { type: 'user_message_echo'; text: string; messageId: string; scoopJid: string }
  | { type: 'status'; scoopStatus: string }
  | { type: 'error'; error: string }
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
  | { type: 'fs.request'; requestId: string; request: TrayFsRequest }
  | { type: 'fs.response'; requestId: string; response: TrayFsResponse }
  | { type: 'ping' }
  | { type: 'pong' };

export type FollowerToLeaderMessage =
  | { type: 'user_message'; text: string; messageId: string }
  | { type: 'abort' }
  | { type: 'request_snapshot' }
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
  | { type: 'ping' }
  | { type: 'pong' };

// ---------------------------------------------------------------------------
// Target advertisement types
// ---------------------------------------------------------------------------

export interface RemoteTargetInfo {
  targetId: string;
  title: string;
  url: string;
}

export interface TrayTargetEntry {
  targetId: string; // Unique within the tray: "{runtimeId}:{localTargetId}"
  localTargetId: string; // The original targetId on the owning runtime
  runtimeId: string; // Which runtime owns this target
  title: string;
  url: string;
  isLocal: boolean; // True if owned by the receiving runtime (set by consumer, not registry)
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
