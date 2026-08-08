/**
 * Tray sync data-channel runtime — `TraySyncChannel`, chunking helpers, and
 * typed factories over the canonical wire format.
 *
 * The message unions and payload types are canonical in
 * `@slicc/shared-ts/src/tray-sync-protocol.ts` (mirrored by the iOS follower
 * `packages/ios-app/SliccTrayKit/Models/SyncProtocol.swift` — see
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
  TrayChunkFrame,
  TraySyncMessage,
} from '@slicc/shared-ts';
import {
  CDP_CHUNK_THRESHOLD,
  isTrayChunkFrame,
  TRAY_CHUNK_FRAME_TYPE,
  TRAY_DEFAULT_MAX_MESSAGE_BYTES,
  TRAY_MAX_CHUNK_COUNT,
  TRAY_MAX_MESSAGE_BYTES,
  TRAY_MAX_PENDING_REASSEMBLIES,
  TRAY_MAX_REASSEMBLY_BYTES,
  TRAY_SEND_HIGH_WATER_BYTES,
} from '@slicc/shared-ts';
import { createLogger } from '../base/logger.js';
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
  TranscriptExportSelector,
  TrayChunkFrame,
  TrayExecChunkMessage,
  TrayExecRequestMessage,
  TrayExecResponseMessage,
  TrayExecSignalMessage,
  TrayFsRequest,
  TrayFsResponse,
  TrayFsResponseData,
  TrayModelCatalogEntry,
  TrayModelSelectionState,
  TraySyncCapabilities,
  TraySyncHelloMessage,
  TraySyncMessage,
  TrayTargetEntry,
  TrayThinkingLevel,
} from '@slicc/shared-ts';
export {
  CHERRY_RUNTIME_TAG,
  isCherryHostEventMessage,
  isCherrySliccEventMessage,
  isTrayChunkFrame,
  TRAY_CHUNK_FRAME_TYPE,
  TRAY_DEFAULT_MAX_MESSAGE_BYTES,
  TRAY_MAX_MESSAGE_BYTES,
  TRAY_SYNC_PROTOCOL_VERSION,
  unhandledProtocolMessage,
} from '@slicc/shared-ts';

const log = createLogger('tray-sync');

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
// Transport-level chunk framing
// ---------------------------------------------------------------------------

const textEncoder = new TextEncoder();

/** UTF-8 byte length of a string — what SCTP actually measures. */
function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).length;
}

/**
 * Worst-case UTF-8 bytes produced per UTF-16 code unit of `chunkData` once it
 * is re-escaped into a frame.
 *
 * The slice being framed is already-serialized JSON, so: a non-ASCII BMP
 * character is passed through literally and costs 3 UTF-8 bytes, while ASCII
 * that needs re-escaping (`\` → `\\`, `"` → `\"`) costs 2. 3 is therefore the
 * true worst case; 4 is the margin actually used, which also absorbs the frame
 * envelope without a second measuring pass.
 *
 * This is why chunk sizing is computed in code units but validated in bytes —
 * the pre-existing per-type chunkers compare `.length` (UTF-16 units) against a
 * byte budget, which under-counts CJK content 3×.
 */
const WORST_CASE_BYTES_PER_UNIT = 4;

/** Envelope allowance (bytes) for `type`, `chunkId`, and the two indices. */
const CHUNK_ENVELOPE_BYTES = 512;

/**
 * Upper bound on frame payload in UTF-16 units, matching the pre-existing
 * per-type chunkers so wire behaviour stays uniform across mechanisms.
 */
const MAX_CHUNK_UNITS = 32 * 1024;

let chunkIdCounter = 0;

/** Collision-free within a channel: a per-process counter plus a random tag. */
function nextChunkId(): string {
  chunkIdCounter += 1;
  return `c${chunkIdCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Slice a serialized message into frames that each fit `maxMessageBytes`.
 *
 * Cuts never fall between the two halves of a surrogate pair. JS strings are
 * UTF-16, so slicing by code unit can split an astral character (emoji, CJK
 * extensions, math alphanumerics) down the middle. `JSON.stringify` then emits
 * each half as a lone `\udXXX` escape — which JS itself rejoins losslessly, so a
 * same-runtime round-trip looks fine, but Go's `encoding/json` decodes an
 * unpaired escape to U+FFFD. The character reaches a CLI follower destroyed and
 * unrecoverable. Slices are therefore built first and counted after, since a
 * boundary adjustment can change how many there are.
 *
 * Exported for tests: the size guarantee is the whole point of this module, and
 * asserting it directly beats inferring it from channel behaviour.
 */
export function frameChunks(
  payload: string,
  maxMessageBytes: number,
  chunkId: string = nextChunkId()
): TrayChunkFrame[] {
  const budget = Math.max(1, maxMessageBytes - CHUNK_ENVELOPE_BYTES);
  const unitsPerChunk = Math.max(
    1,
    Math.min(MAX_CHUNK_UNITS, Math.floor(budget / WORST_CASE_BYTES_PER_UNIT))
  );

  const slices: string[] = [];
  for (let start = 0; start < payload.length; ) {
    let end = Math.min(start + unitsPerChunk, payload.length);
    // Never cut between a high surrogate and its low surrogate.
    if (end < payload.length && isHighSurrogate(payload.charCodeAt(end - 1))) {
      end -= 1;
    }
    if (end <= start) end = start + unitsPerChunk; // pathological; accept the split
    slices.push(payload.slice(start, end));
    start = end;
  }
  if (slices.length === 0) slices.push('');

  return slices.map((chunkData, chunkIndex) => ({
    type: TRAY_CHUNK_FRAME_TYPE,
    chunkId,
    chunkIndex,
    totalChunks: slices.length,
    chunkData,
  }));
}

/** True for the leading half of a UTF-16 surrogate pair. */
function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

interface ReassemblyBuffer {
  chunks: string[];
  received: number;
  totalChunks: number;
  bytes: number;
  startedAt: number;
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
  /** In-flight inbound reassemblies, keyed by `chunkId`. Insertion-ordered. */
  private readonly reassembly = new Map<string, ReassemblyBuffer>();
  private reassemblyBytes = 0;

  constructor(private readonly channel: TrayDataChannelLike) {
    this.channel.addEventListener('message', (event: { data: string }) => {
      if (this.closed) return;
      try {
        const parsed: unknown = JSON.parse(event.data);
        // Transport frames are intercepted BEFORE the message union is
        // considered: reassembly completes into a normal message, so listeners
        // (and every handler switch behind them) never see framing at all.
        // `__chunk` is reserved transport vocabulary — a frame that fails
        // validation is dropped rather than delivered as a message, matching
        // the Go and Swift followers.
        if ((parsed as { type?: unknown } | null)?.type === TRAY_CHUNK_FRAME_TYPE) {
          if (isTrayChunkFrame(parsed)) this.acceptChunkFrame(parsed);
          else log.warn('Dropping malformed tray sync chunk frame');
          return;
        }
        this.emit(parsed as TReceive);
      } catch (error) {
        log.warn('Failed to parse tray sync message', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  private emit(message: TReceive): void {
    for (const listener of this.listeners) {
      listener(message);
    }
  }

  /**
   * Buffer one inbound frame, emitting the reconstructed message once the last
   * one lands.
   *
   * Bounded on both axes (`TRAY_MAX_PENDING_REASSEMBLIES`,
   * `TRAY_MAX_REASSEMBLY_BYTES`), evicting oldest-first: a peer that starts
   * many large messages and finishes none must not grow leader memory without
   * limit. Frames are index-addressed, so out-of-order delivery is fine even
   * though SCTP data channels are ordered by default.
   */
  private acceptChunkFrame(frame: TrayChunkFrame): void {
    let buffer = this.reassembly.get(frame.chunkId);
    // `totalChunks` must not change mid-message: a peer that re-declares it is
    // either buggy or probing for an out-of-bounds write against the buffer
    // sized by the first frame.
    if (buffer && buffer.totalChunks !== frame.totalChunks) {
      log.error('Dropping a tray sync chunk frame with inconsistent totalChunks', {
        chunkId: frame.chunkId,
        expected: buffer.totalChunks,
        received: frame.totalChunks,
      });
      return;
    }
    if (!buffer) {
      buffer = {
        chunks: new Array(frame.totalChunks),
        received: 0,
        totalChunks: frame.totalChunks,
        bytes: 0,
        startedAt: Date.now(),
      };
      this.reassembly.set(frame.chunkId, buffer);
      this.evictOverflowingReassemblies();
    }
    if (buffer.chunks[frame.chunkIndex] !== undefined) return; // duplicate

    buffer.chunks[frame.chunkIndex] = frame.chunkData;
    buffer.received++;
    const added = utf8ByteLength(frame.chunkData);
    buffer.bytes += added;
    this.reassemblyBytes += added;

    // Per-message cap, matching the sender's refusal and the Go/Swift
    // receivers. Without it a single stream could grow to the aggregate bound
    // (32 MiB) — four times what any sender here will emit.
    if (buffer.bytes > TRAY_MAX_MESSAGE_BYTES) {
      log.error('Dropping an oversize chunked tray sync message', {
        chunkId: frame.chunkId,
        bytes: buffer.bytes,
        limit: TRAY_MAX_MESSAGE_BYTES,
      });
      this.dropReassembly(frame.chunkId);
      return;
    }

    if (buffer.received < buffer.totalChunks) {
      this.evictOverflowingReassemblies();
      return;
    }

    this.dropReassembly(frame.chunkId);
    try {
      this.emit(JSON.parse(buffer.chunks.join('')) as TReceive);
    } catch (error) {
      log.error('Failed to reassemble chunked tray sync message', {
        chunkId: frame.chunkId,
        totalChunks: buffer.totalChunks,
        bytes: buffer.bytes,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private dropReassembly(chunkId: string): void {
    const buffer = this.reassembly.get(chunkId);
    if (!buffer) return;
    this.reassemblyBytes -= buffer.bytes;
    this.reassembly.delete(chunkId);
  }

  private evictOverflowingReassemblies(): void {
    while (
      this.reassembly.size > TRAY_MAX_PENDING_REASSEMBLIES ||
      this.reassemblyBytes > TRAY_MAX_REASSEMBLY_BYTES
    ) {
      const oldest = this.reassembly.keys().next();
      if (oldest.done) return;
      const buffer = this.reassembly.get(oldest.value);
      log.error('Evicted an incomplete tray sync reassembly', {
        chunkId: oldest.value,
        received: buffer?.received,
        totalChunks: buffer?.totalChunks,
        ageMs: buffer ? Date.now() - buffer.startedAt : undefined,
      });
      this.dropReassembly(oldest.value);
    }
  }

  /**
   * The SCTP `maxMessageSize` for this channel, or the RFC 8831 floor when the
   * transport hasn't reported one (test doubles, pre-negotiation).
   */
  private get maxMessageBytes(): number {
    const reported = this.channel.getMaxMessageSize?.();
    return typeof reported === 'number' && reported > 0 ? reported : TRAY_DEFAULT_MAX_MESSAGE_BYTES;
  }

  /**
   * Send a message, chunking it when it exceeds the transport's limit.
   * Returns true if the message (or all of its frames) went out.
   *
   * A `false` return is now meaningful: before #1700 an oversize message threw
   * inside here, got logged, and returned false that every non-chunked caller
   * ignored — so followers silently missed screenshots and large tool results.
   */
  send(message: TSend): boolean {
    if (this.closed) return false;
    const type = (message as { type: string }).type;
    let serialized: string;
    try {
      serialized = JSON.stringify(message);
    } catch (error) {
      log.error('Failed to serialize tray sync message', {
        type,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }

    const bytes = utf8ByteLength(serialized);
    if (bytes <= this.maxMessageBytes) {
      return this.writeRaw(serialized, type);
    }
    return this.sendChunked(serialized, bytes, type);
  }

  private writeRaw(payload: string, type: string): boolean {
    try {
      this.channel.send(payload);
      return true;
    } catch (error) {
      log.error('Failed to send tray sync message', {
        type,
        bytes: utf8ByteLength(payload),
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Frame and write an oversize message, refusing before it can throw.
   *
   * Two refusals, both loud, both returning false so the caller can degrade:
   * - over `TRAY_MAX_MESSAGE_BYTES`: chunking this would queue hundreds of
   *   frames and risk wedging the channel for everything behind it.
   * - already past `TRAY_SEND_HIGH_WATER_BYTES` of queued data: the next write
   *   is heading for `OperationError: send queue is full`.
   *
   * The high-water check is deliberately NOT applied to small messages, so a
   * congested channel still passes keepalive ping/pong and a merely busy peer
   * isn't mistaken for a dead one (#1696).
   */
  private sendChunked(serialized: string, bytes: number, type: string): boolean {
    if (bytes > TRAY_MAX_MESSAGE_BYTES) {
      log.error('Refusing to send an oversize tray sync message', {
        type,
        bytes,
        limit: TRAY_MAX_MESSAGE_BYTES,
      });
      return false;
    }
    const queued = this.channel.bufferedAmount;
    if (typeof queued === 'number' && queued >= TRAY_SEND_HIGH_WATER_BYTES) {
      log.error('Refusing to send a chunked tray sync message — channel is congested', {
        type,
        bytes,
        bufferedAmount: queued,
        highWater: TRAY_SEND_HIGH_WATER_BYTES,
      });
      return false;
    }

    const frames = frameChunks(serialized, this.maxMessageBytes);
    // Sender/receiver symmetry: never emit more frames than a peer will accept.
    // Unreachable with a conforming transport (8 MiB over >=16 KiB frames is
    // ~512), but a transport reporting an absurdly small limit would otherwise
    // produce a message no receiver can reassemble.
    if (frames.length > TRAY_MAX_CHUNK_COUNT) {
      log.error('Refusing to send a message needing too many frames', {
        type,
        bytes,
        frames: frames.length,
        limit: TRAY_MAX_CHUNK_COUNT,
      });
      return false;
    }
    for (const frame of frames) {
      if (!this.writeRaw(JSON.stringify(frame), TRAY_CHUNK_FRAME_TYPE)) {
        log.error('Chunked tray sync send failed part-way', {
          type,
          bytes,
          chunkIndex: frame.chunkIndex,
          totalChunks: frame.totalChunks,
        });
        return false;
      }
    }
    log.debug('Sent a chunked tray sync message', { type, bytes, totalChunks: frames.length });
    return true;
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
    this.reassembly.clear();
    this.reassemblyBytes = 0;
    this.channel.close();
  }

  get isOpen(): boolean {
    return !this.closed && this.channel.readyState === 'open';
  }

  /** Bytes queued in the underlying channel; undefined when the channel is a test double. */
  get bufferedAmount(): number | undefined {
    return this.channel.bufferedAmount;
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
