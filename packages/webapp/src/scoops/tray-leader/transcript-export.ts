import type { TranscriptExportErrorCode, TranscriptExportSelector } from '@slicc/shared-ts';
import { TranscriptExportError } from '@slicc/shared-ts';
import type { TranscriptZipResult } from '../../transcript/zip-stream.js';
import type { LeaderSyncContext } from './context.js';
import { labelForFollower } from './follower-registry.js';

/** Max payload per chunk message: 32 KiB of base64 text. */
const EXPORT_CHUNK_B64_MAX = 32 * 1024;
/** Backpressure threshold: pause when bufferedAmount exceeds 1 MiB. */
const EXPORT_BACKPRESSURE_THRESHOLD = 1024 * 1024;
/** Per-ack deadline for a follower whose durable write stalls. */
const ACK_TIMEOUT_MS = 30_000;
/** Minimum peer protocol version that supports transcript.export.ack. */
const ACK_PROTOCOL_VERSION_MIN = 3;

interface SendExportChunksCtx {
  bootstrapId: string;
  requestId: string;
  chunks: AsyncIterable<Uint8Array>;
  hasher: { update(data: Uint8Array): void };
  abort: AbortController;
  onSlice: (index: number, slice: string) => boolean;
  awaitAck: boolean;
}

interface SendExportChunksResult {
  streamError: boolean;
  chunkCount: number;
  byteLength: number;
}

interface SendExportSlicesCtx {
  bootstrapId: string;
  requestId: string;
  b64: string;
  sync: { bufferedAmount?: number };
  key: string;
  abort: AbortController;
  onSlice: (index: number, slice: string) => boolean;
  awaitAck: boolean;
  startIdx: number;
}

/**
 * The sudoers subject for an export selector: `active` for the live session,
 * `frozen:<sessionId>` for an archive. This is what `NOPASSWD Export <glob>`
 * rules match and what the approval card shows.
 */
export function exportSubject(selector: TranscriptExportSelector): string {
  return selector.kind === 'frozen' ? `frozen:${selector.sessionId}` : 'active';
}

/** Encode bytes without overflowing the JS argument stack. */
function bytesToBase64(data: Uint8Array): string {
  const CHUNK = 8192;
  let binary = '';
  for (let i = 0; i < data.length; i += CHUNK) {
    binary += String.fromCharCode(...data.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Wait until the data channel's buffered amount drops below the threshold. */
async function waitForBufferedAmountLow(
  channel: { bufferedAmount?: number },
  threshold: number,
  signal: AbortSignal
): Promise<void> {
  if (typeof channel.bufferedAmount !== 'number') return;
  while (!signal.aborted && channel.bufferedAmount > threshold) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

export class TranscriptExportManager {
  /** In-flight requests keyed by the owner-scoped bootstrapId:requestId pair. */
  readonly activeExports = new Map<string, { bootstrapId: string; abort: AbortController }>();
  /** Owner-scoped durable-write acknowledgement waiters. */
  private readonly ackWaiters = new Map<
    string,
    { resolve: () => void; reject: (err: Error) => void }
  >();
  constructor(private readonly context: LeaderSyncContext) {
    context.followers.onFollowerRemoved({
      afterRegistryCleanup: (bootstrapId) => this.handleFollowerRemoved(bootstrapId),
    });
  }

  private static exportKey(bootstrapId: string, requestId: string): string {
    return `${bootstrapId}:${requestId}`;
  }

  private static ackKey(bootstrapId: string, requestId: string, index: number): string {
    return `${bootstrapId}:${requestId}:${index}`;
  }

  private clearAckWaiters(bootstrapId: string, requestId: string): void {
    const prefix = `${bootstrapId}:${requestId}:`;
    for (const [key, waiter] of this.ackWaiters) {
      if (!key.startsWith(prefix)) continue;
      waiter.reject(new Error('export aborted'));
      this.ackWaiters.delete(key);
    }
  }

  private handleFollowerRemoved(bootstrapId: string): void {
    for (const [key, entry] of this.activeExports) {
      if (entry.bootstrapId !== bootstrapId) continue;
      entry.abort.abort();
      const requestId = key.slice(bootstrapId.length + 1);
      this.clearAckWaiters(bootstrapId, requestId);
      this.activeExports.delete(key);
    }
  }

  async handleTranscriptExportRequest(
    bootstrapId: string,
    requestId: string,
    selector: TranscriptExportSelector
  ): Promise<void> {
    const key = TranscriptExportManager.exportKey(bootstrapId, requestId);
    if (this.activeExports.has(key)) {
      this.context.log.warn('Duplicate transcript export request from same follower, ignoring', {
        bootstrapId,
        requestId,
      });
      return;
    }

    const follower = this.context.followers.followers.get(bootstrapId);
    if (!follower) return;
    const { requestSudoApproval, createTranscriptExport } = this.context.options;
    if (!requestSudoApproval || !createTranscriptExport) {
      follower.sync.send({ type: 'transcript.export.denied', requestId });
      return;
    }

    const hasInFlight = [...this.activeExports.values()].some(
      (entry) => entry.bootstrapId === bootstrapId
    );
    if (hasInFlight) {
      this.context.log.warn('Follower already has an in-flight export; denying duplicate', {
        bootstrapId,
        requestId,
      });
      follower.sync.send({ type: 'transcript.export.denied', requestId });
      return;
    }

    const abort = new AbortController();
    this.activeExports.set(key, { bootstrapId, abort });
    const followerLabel = labelForFollower(follower.floatType, follower.runtime);
    follower.sync.send({ type: 'transcript.export.pending', requestId });

    // The export gate is a sudo action (issue #2062): the kernel's SudoManager
    // checks `NOPASSWD Export` grants, then routes the prompt wherever the
    // human is — the leader's own dialog, or a tray follower's Face ID sheet —
    // and persists an "Always" verdict. `allow` and `always` both approve.
    let approved = false;
    try {
      const decision = await requestSudoApproval({
        kind: 'export',
        detail: exportSubject(selector),
        suggestedPattern: exportSubject(selector),
        followerLabel,
        hostOrigin: follower.hostOrigin,
      });
      approved = decision.decision === 'allow' || decision.decision === 'always';
    } catch (err) {
      this.context.log.warn('transcript export approval threw', {
        requestId,
        error: err instanceof Error ? err.message : String(err),
      });
      approved = false;
    }

    const stillConnected = this.context.followers.followers.get(bootstrapId);
    if (!this.activeExports.has(key) || !stillConnected) {
      this.activeExports.delete(key);
      return;
    }
    if (!approved) {
      stillConnected.sync.send({ type: 'transcript.export.denied', requestId });
      this.activeExports.delete(key);
      return;
    }
    void this.streamTranscriptExport(bootstrapId, requestId, selector, abort);
  }

  handleTranscriptExportCancel(bootstrapId: string, requestId: string): void {
    const key = TranscriptExportManager.exportKey(bootstrapId, requestId);
    const entry = this.activeExports.get(key);
    if (!entry) return;
    this.context.log.info('Transcript export cancelled by follower', { requestId, bootstrapId });
    entry.abort.abort();
    this.activeExports.delete(key);
    this.clearAckWaiters(bootstrapId, requestId);
  }

  handleTranscriptExportAck(bootstrapId: string, requestId: string, index: number): void {
    const key = TranscriptExportManager.ackKey(bootstrapId, requestId, index);
    const waiter = this.ackWaiters.get(key);
    if (!waiter) return;
    this.ackWaiters.delete(key);
    waiter.resolve();
  }

  private async streamTranscriptExport(
    bootstrapId: string,
    requestId: string,
    selector: TranscriptExportSelector,
    abort: AbortController
  ): Promise<void> {
    const key = TranscriptExportManager.exportKey(bootstrapId, requestId);
    const { createTranscriptExport } = this.context.options;
    const follower = this.context.followers.followers.get(bootstrapId);
    if (!follower || !createTranscriptExport) {
      this.activeExports.delete(key);
      return;
    }
    const sendErr = (code: TranscriptExportErrorCode): void => {
      const connected = this.context.followers.followers.get(bootstrapId);
      if (connected) connected.sync.send({ type: 'transcript.export.error', requestId, code });
      this.activeExports.delete(key);
    };

    let result: TranscriptZipResult;
    try {
      result = await createTranscriptExport(selector, abort.signal);
    } catch (createErr) {
      if (abort.signal.aborted) {
        this.activeExports.delete(key);
        return;
      }
      this.context.log.warn('createTranscriptExport failed', {
        requestId,
        error: createErr instanceof Error ? createErr.message : String(createErr),
      });
      const code: TranscriptExportErrorCode =
        createErr instanceof TranscriptExportError ? createErr.code : 'session-not-found';
      sendErr(code);
      return;
    }

    if (abort.signal.aborted || !this.activeExports.has(key)) {
      this.activeExports.delete(key);
      return;
    }
    const sync = this.context.followers.followers.get(bootstrapId)?.sync;
    if (!sync) {
      this.activeExports.delete(key);
      return;
    }
    sync.send({ type: 'transcript.export.start', requestId, filename: result.filename });

    const { sha256: sha256Lib } = await import('js-sha256');
    const hasher = sha256Lib.create();
    const followerForAck = this.context.followers.followers.get(bootstrapId);
    const awaitAck = (followerForAck?.peerProtocolVersion ?? 0) >= ACK_PROTOCOL_VERSION_MIN;
    const {
      streamError,
      chunkCount: chunkIndex,
      byteLength: leaderByteCount,
    } = await this.sendExportChunks({
      bootstrapId,
      requestId,
      chunks: result.chunks,
      hasher,
      abort,
      awaitAck,
      onSlice: (index, data) => {
        const connected = this.context.followers.followers.get(bootstrapId);
        if (!connected) return false;
        connected.sync.send({ type: 'transcript.export.chunk', requestId, index, data });
        return true;
      },
    });
    if (streamError) {
      sendErr('transfer-corrupt');
      return;
    }
    if (!this.activeExports.has(key)) return;
    if (abort.signal.aborted) {
      sendErr('transfer-aborted');
      return;
    }

    let completion: { byteLength: number; sha256: string };
    try {
      completion = await result.completion;
    } catch {
      if (abort.signal.aborted) {
        this.activeExports.delete(key);
        return;
      }
      sendErr('transfer-aborted');
      return;
    }
    if (abort.signal.aborted || !this.activeExports.has(key)) {
      this.activeExports.delete(key);
      return;
    }
    if (completion.byteLength !== leaderByteCount) {
      this.context.log.warn(
        'Transcript export byte count mismatch between service and leader stream',
        { requestId, serviceByteLength: completion.byteLength, leaderByteCount }
      );
      sendErr('transfer-corrupt');
      return;
    }
    const leaderSha = hasher.hex();
    if (completion.sha256 !== leaderSha) {
      this.context.log.warn(
        'Transcript export SHA-256 mismatch between service and leader stream',
        {
          requestId,
        }
      );
      sendErr('transfer-corrupt');
      return;
    }

    const done = this.context.followers.followers.get(bootstrapId);
    if (done) {
      done.sync.send({
        type: 'transcript.export.complete',
        requestId,
        chunks: chunkIndex,
        byteLength: leaderByteCount,
        sha256: leaderSha,
      });
    }
    this.activeExports.delete(key);
  }

  private async sendExportChunks(ctx: SendExportChunksCtx): Promise<SendExportChunksResult> {
    const { bootstrapId, requestId, chunks, hasher, abort, onSlice, awaitAck } = ctx;
    const key = TranscriptExportManager.exportKey(bootstrapId, requestId);
    const sync = this.context.followers.followers.get(bootstrapId)?.sync;
    if (!sync) return { streamError: true, chunkCount: 0, byteLength: 0 };
    let idx = 0;
    let byteCount = 0;
    try {
      for await (const raw of chunks) {
        if (abort.signal.aborted || !this.activeExports.has(key)) {
          return { streamError: false, chunkCount: idx, byteLength: byteCount };
        }
        hasher.update(raw);
        byteCount += raw.byteLength;
        const sliceResult = await this.sendExportSlices({
          bootstrapId,
          requestId,
          b64: bytesToBase64(raw),
          sync,
          key,
          abort,
          onSlice,
          awaitAck,
          startIdx: idx,
        });
        idx = sliceResult.nextIdx;
        if (sliceResult.done !== 'continue') {
          return {
            streamError: sliceResult.done === 'error',
            chunkCount: idx,
            byteLength: byteCount,
          };
        }
      }
    } catch (streamErr) {
      if (abort.signal.aborted) {
        return { streamError: false, chunkCount: idx, byteLength: byteCount };
      }
      this.context.log.warn('Error streaming transcript export chunks', {
        requestId,
        error: streamErr instanceof Error ? streamErr.message : String(streamErr),
      });
      return { streamError: true, chunkCount: idx, byteLength: byteCount };
    }
    return { streamError: false, chunkCount: idx, byteLength: byteCount };
  }

  private async sendExportSlices(
    ctx: SendExportSlicesCtx
  ): Promise<{ nextIdx: number; done: 'continue' | 'abort' | 'error' }> {
    const { bootstrapId, requestId, b64, sync, key, abort, onSlice, awaitAck } = ctx;
    let idx = ctx.startIdx;
    for (let off = 0; off < b64.length; off += EXPORT_CHUNK_B64_MAX) {
      if (abort.signal.aborted || !this.activeExports.has(key)) {
        return { nextIdx: idx, done: 'abort' };
      }
      await waitForBufferedAmountLow(sync, EXPORT_BACKPRESSURE_THRESHOLD, abort.signal);
      if (abort.signal.aborted || !this.activeExports.has(key)) {
        return { nextIdx: idx, done: 'abort' };
      }
      const slice = b64.slice(off, off + EXPORT_CHUNK_B64_MAX);
      if (!onSlice(idx, slice)) return { nextIdx: idx, done: 'error' };
      if (awaitAck) {
        const waited = await this.waitForAck(bootstrapId, requestId, idx, abort);
        if (!waited || abort.signal.aborted || !this.activeExports.has(key)) {
          return { nextIdx: idx + 1, done: 'abort' };
        }
      }
      idx++;
    }
    return { nextIdx: idx, done: 'continue' };
  }

  private waitForAck(
    bootstrapId: string,
    requestId: string,
    index: number,
    abort: AbortController
  ): Promise<boolean> {
    const signal = abort.signal;
    return new Promise<boolean>((resolve) => {
      if (signal.aborted) {
        resolve(false);
        return;
      }
      const key = TranscriptExportManager.ackKey(bootstrapId, requestId, index);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const clearTimer = (): void => {
        if (timer === undefined) return;
        clearTimeout(timer);
        timer = undefined;
      };
      const cleanup = (): void => {
        this.ackWaiters.delete(key);
        clearTimer();
      };
      const onAbort = (): void => {
        cleanup();
        resolve(false);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => {
        timer = undefined;
        abort.abort();
        this.clearAckWaiters(bootstrapId, requestId);
      }, ACK_TIMEOUT_MS);
      this.ackWaiters.set(key, {
        resolve: () => {
          signal.removeEventListener('abort', onAbort);
          cleanup();
          resolve(true);
        },
        reject: () => {
          signal.removeEventListener('abort', onAbort);
          cleanup();
          resolve(false);
        },
      });
    });
  }
}
