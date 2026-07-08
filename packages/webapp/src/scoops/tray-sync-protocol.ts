/**
 * Tray sync data-channel runtime — `TraySyncChannel`, chunking helpers, and
 * typed factories over the canonical wire format.
 *
 * The message unions and payload types are canonical in
 * `@slicc/shared-ts/src/tray-sync-protocol.ts` (mirrored by the iOS follower
 * `packages/ios-app/SliccFollower/Models/SyncProtocol.swift` — see
 * `packages/ios-app/CLAUDE.md` "Protocol Mirror Invariant" and the
 * golden-fixture corpus in `tray-sync-protocol-corpus.ts`). This module
 * re-exports them so webapp importers keep their scoops/-layer import site,
 * and holds the runtime pieces that depend on `TrayDataChannelLike` and the
 * webapp logger.
 */

import type {
  ChatMessage,
  FollowerToLeaderMessage,
  LeaderToFollowerMessage,
  TraySyncMessage,
} from '@slicc/shared-ts';
import { createLogger } from '../core/logger.js';
import type { TrayDataChannelLike } from './tray-webrtc.js';

export type {
  CherryHostEventMessage,
  CherrySliccEventMessage,
  CookieTeleportCookie,
  FollowerToLeaderMessage,
  LeaderToFollowerMessage,
  RemoteTargetInfo,
  ScoopSummary,
  SprinkleSummary,
  TrayFsRequest,
  TrayFsResponse,
  TrayFsResponseData,
  TraySyncHelloMessage,
  TraySyncMessage,
  TrayTargetEntry,
} from '@slicc/shared-ts';
export {
  CHERRY_RUNTIME_TAG,
  isCherryHostEventMessage,
  isCherrySliccEventMessage,
  TRAY_SYNC_PROTOCOL_VERSION,
  unhandledProtocolMessage,
} from '@slicc/shared-ts';

const log = createLogger('tray-sync');

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
