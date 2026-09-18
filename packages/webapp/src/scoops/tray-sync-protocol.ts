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
  FollowerBiscottoGate,
  FollowerBiscottoIdentity,
  FollowerToLeaderMessage,
  LeaderToFollowerMessage,
  RemoteTargetInfo,
  ScoopSummary,
  ScoopSummaryModel,
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

const SNAPSHOT_CHUNK_SIZE = 32 * 1024;

export function sendSnapshot(
  channel: { send(message: LeaderToFollowerMessage): boolean },
  messages: ChatMessage[],
  scoopJid: string
): boolean {
  const serialized = JSON.stringify({ messages, scoopJid });
  if (serialized.length <= CDP_CHUNK_THRESHOLD) {
    return channel.send({ type: 'snapshot', messages, scoopJid });
  }

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

export type SnapshotChunkBuffer = {
  chunks: string[];
  received: number;
  totalChunks: number;
};

export function reassembleSnapshot(
  buffers: Map<string, SnapshotChunkBuffer>,
  message: Extract<LeaderToFollowerMessage, { type: 'snapshot_chunk' }>
): { messages: ChatMessage[]; scoopJid: string } | null {
  let buffer = buffers.get(message.scoopJid);
  if (!buffer || buffer.totalChunks !== message.totalChunks) {
    buffer = {
      chunks: new Array(message.totalChunks),
      received: 0,
      totalChunks: message.totalChunks,
    };
    buffers.set(message.scoopJid, buffer);
  }

  if (!buffer.chunks[message.chunkIndex]) {
    buffer.chunks[message.chunkIndex] = message.chunkData;
    buffer.received++;
  }

  if (buffer.received < buffer.totalChunks) return null;

  buffers.delete(message.scoopJid);
  try {
    return JSON.parse(buffer.chunks.join('')) as {
      messages: ChatMessage[];
      scoopJid: string;
    };
  } catch (err) {
    log.error('Failed to reassemble snapshot', {
      error: err instanceof Error ? err.message : String(err),
      scoopJid: message.scoopJid,
    });
    return { messages: [], scoopJid: message.scoopJid };
  }
}

const textEncoder = new TextEncoder();

function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).length;
}

const WORST_CASE_BYTES_PER_UNIT = 4;

const CHUNK_ENVELOPE_BYTES = 512;

const MAX_CHUNK_UNITS = 32 * 1024;

let chunkIdCounter = 0;

function nextChunkId(): string {
  chunkIdCounter += 1;
  return `c${chunkIdCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

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

    if (end < payload.length && isHighSurrogate(payload.charCodeAt(end - 1))) {
      end -= 1;
    }
    if (end <= start) end = start + unitsPerChunk;
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

export class TraySyncChannel<
  TSend extends TraySyncMessage = TraySyncMessage,
  TReceive extends TraySyncMessage = TraySyncMessage,
> {
  private readonly listeners: Array<(message: TReceive) => void> = [];
  private closed = false;

  private readonly reassembly = new Map<string, ReassemblyBuffer>();
  private reassemblyBytes = 0;

  constructor(private readonly channel: TrayDataChannelLike) {
    this.channel.addEventListener('message', (event: { data: string }) => {
      if (this.closed) return;
      try {
        const parsed: unknown = JSON.parse(event.data);

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

  private acceptChunkFrame(frame: TrayChunkFrame): void {
    let buffer = this.reassembly.get(frame.chunkId);

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
    if (buffer.chunks[frame.chunkIndex] !== undefined) return;

    buffer.chunks[frame.chunkIndex] = frame.chunkData;
    buffer.received++;
    const added = utf8ByteLength(frame.chunkData);
    buffer.bytes += added;
    this.reassemblyBytes += added;

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

  private get maxMessageBytes(): number {
    const reported = this.channel.getMaxMessageSize?.();
    return typeof reported === 'number' && reported > 0 ? reported : TRAY_DEFAULT_MAX_MESSAGE_BYTES;
  }

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

  get bufferedAmount(): number | undefined {
    return this.channel.bufferedAmount;
  }
}

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
