import type { TranscriptExportErrorCode, TranscriptExportProgress } from '@slicc/shared-ts';
import {
  TranscriptExportError,
  type TranscriptExportSelector,
  VALID_EXPORT_ERROR_CODES,
} from '@slicc/shared-ts';
import type { ExportSpool } from '../../transcript/export-spool.js';
import { makeExportSpool } from '../../transcript/export-spool.js';
import { type LeaderToFollowerMessage, unhandledProtocolMessage } from '../tray-sync-protocol.js';
import type { FollowerSyncContext } from './context.js';

interface ActiveExport {
  resolve: (blob: Blob) => void;
  reject: (err: Error) => void;
  spool: ExportSpool;
  nextExpectedIndex: number;
  totalBytes: number;
  signal: AbortSignal;
  onAbort: () => void;
  onProgress?: (progress: TranscriptExportProgress) => void;
}

type ExportLeaderMessage = Extract<
  LeaderToFollowerMessage,
  {
    type:
      | 'transcript.export.pending'
      | 'transcript.export.denied'
      | 'transcript.export.start'
      | 'transcript.export.chunk'
      | 'transcript.export.complete'
      | 'transcript.export.error';
  }
>;

export class FollowerExportClient {
  readonly activeExportRequests = new Map<string, ActiveExport>();

  constructor(private readonly context: FollowerSyncContext) {}

  handleLeaderMessage(message: ExportLeaderMessage): void {
    switch (message.type) {
      case 'transcript.export.pending':
        this.context.log.debug('Transcript export pending', { requestId: message.requestId });
        this.activeExportRequests.get(message.requestId)?.onProgress?.({
          phase: 'collecting',
        });
        break;
      case 'transcript.export.denied':
        this.handleDenied(message.requestId);
        break;
      case 'transcript.export.start':
        this.context.log.debug('Transcript export start', { requestId: message.requestId });
        this.activeExportRequests.get(message.requestId)?.onProgress?.({
          phase: 'packaging',
        });
        break;
      case 'transcript.export.chunk':
        void this.handleChunkAsync(message.requestId, message.index, message.data);
        break;
      case 'transcript.export.complete':
        void this.handleComplete(
          message.requestId,
          message.chunks,
          message.byteLength,
          message.sha256
        );
        break;
      case 'transcript.export.error':
        this.handleError(message.requestId, message.code);
        break;
      default: {
        const unknown = unhandledProtocolMessage(message);
        this.context.log.warn('Unknown transcript export leader message — skewed leader?', {
          type: unknown.type,
        });
        break;
      }
    }
  }

  requestTranscriptExport(
    selector: TranscriptExportSelector,
    signal: AbortSignal,
    onProgress?: (progress: TranscriptExportProgress) => void
  ): Promise<Blob> {
    if (signal.aborted) {
      return Promise.reject(new TranscriptExportError('transfer-aborted'));
    }

    const requestId = `te-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const spoolFactory = this.context.options.makeExportSpool ?? makeExportSpool;
    const spool = spoolFactory(requestId);

    return new Promise<Blob>((resolve, reject) => {
      const onAbort = (): void => {
        const entry = this.activeExportRequests.get(requestId);
        if (!entry) return;
        this.context.send({ type: 'transcript.export.cancel', requestId });
        this.activeExportRequests.delete(requestId);
        void entry.spool.cancel();
        reject(new TranscriptExportError('transfer-aborted'));
      };

      if (signal.aborted) {
        void spool.cancel();
        reject(new TranscriptExportError('transfer-aborted'));
        return;
      }

      signal.addEventListener('abort', onAbort, { once: true });

      this.activeExportRequests.set(requestId, {
        resolve,
        reject,
        spool,
        nextExpectedIndex: 0,
        totalBytes: 0,
        signal,
        onAbort,
        onProgress,
      });

      this.context.send({
        type: 'transcript.export.request',
        requestId,
        selector,
      });
    });
  }

  private handleDenied(requestId: string): void {
    const entry = this.activeExportRequests.get(requestId);
    if (!entry) return;
    entry.signal.removeEventListener('abort', entry.onAbort);
    this.activeExportRequests.delete(requestId);
    void entry.spool.cancel();
    entry.reject(new TranscriptExportError('permission-denied'));
  }

  private async handleChunkAsync(requestId: string, index: number, data: string): Promise<void> {
    const entry = this.activeExportRequests.get(requestId);
    if (!entry) return;

    if (index !== entry.nextExpectedIndex) {
      this.context.log.warn('Transcript export chunk out of order', {
        requestId,
        expected: entry.nextExpectedIndex,
        got: index,
      });
      entry.signal.removeEventListener('abort', entry.onAbort);
      this.activeExportRequests.delete(requestId);
      this.context.send({ type: 'transcript.export.cancel', requestId });
      void entry.spool.cancel();
      entry.reject(new TranscriptExportError('transfer-corrupt'));
      return;
    }

    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    entry.totalBytes += bytes.byteLength;
    entry.nextExpectedIndex++;
    entry.onProgress?.({ phase: 'transferring', processedBytes: entry.totalBytes });

    try {
      await entry.spool.append(bytes, index);
    } catch (err) {
      if (!this.activeExportRequests.has(requestId)) return;
      entry.signal.removeEventListener('abort', entry.onAbort);
      this.activeExportRequests.delete(requestId);
      this.context.send({ type: 'transcript.export.cancel', requestId });
      void entry.spool.cancel();
      entry.reject(new TranscriptExportError('transfer-corrupt'));
      this.context.log.warn('Transcript export spool append failed', {
        requestId,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    if (!this.activeExportRequests.has(requestId)) return;
    this.context.send({ type: 'transcript.export.ack', requestId, index });
  }

  private async handleComplete(
    requestId: string,
    expectedChunks: number,
    expectedByteLength: number,
    expectedSha256: string
  ): Promise<void> {
    const entry = this.activeExportRequests.get(requestId);
    if (!entry) return;
    entry.signal.removeEventListener('abort', entry.onAbort);
    this.activeExportRequests.delete(requestId);

    if (entry.nextExpectedIndex !== expectedChunks) {
      this.context.log.warn('Transcript export chunk count mismatch', {
        requestId,
        expected: expectedChunks,
        got: entry.nextExpectedIndex,
      });
      void entry.spool.cancel();
      entry.reject(new TranscriptExportError('transfer-corrupt'));
      return;
    }

    let blob: Blob;
    try {
      blob = await entry.spool.finalize(expectedChunks, expectedByteLength, expectedSha256);
    } catch (err) {
      this.context.log.warn('Transcript export spool finalize failed', {
        requestId,
        error: err instanceof Error ? err.message : String(err),
      });
      entry.reject(new TranscriptExportError('transfer-corrupt'));
      return;
    }

    entry.resolve(blob);
  }

  private handleError(requestId: string, code: TranscriptExportErrorCode): void {
    const entry = this.activeExportRequests.get(requestId);
    if (!entry) return;
    entry.signal.removeEventListener('abort', entry.onAbort);
    this.activeExportRequests.delete(requestId);
    void entry.spool.cancel();
    const safeCode: TranscriptExportErrorCode = VALID_EXPORT_ERROR_CODES.has(
      code as TranscriptExportErrorCode
    )
      ? (code as TranscriptExportErrorCode)
      : 'transfer-corrupt';
    entry.reject(new TranscriptExportError(safeCode));
  }

  rejectPending(): void {
    for (const [, entry] of this.activeExportRequests) {
      entry.signal.removeEventListener('abort', entry.onAbort);
      void entry.spool.cancel();
      entry.reject(new TranscriptExportError('transfer-aborted'));
    }
    this.activeExportRequests.clear();
  }
}
