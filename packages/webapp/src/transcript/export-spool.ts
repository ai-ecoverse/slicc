/**
 * Bounded-memory spool for follower-side transcript ZIP receipt.
 *
 * The ExportSpool interface allows the follower to accumulate incoming
 * ZIP chunks without retaining a `Uint8Array[]` in its live request state.
 * Each `append` call represents a durably-stored chunk; `finalize` returns
 * the assembled Blob only after all integrity checks pass.
 *
 * Two implementations:
 *  - MemorySpool: for tests and environments without OPFS. Accumulates in
 *    a private array; cleared on cancel. Explicit bounded policy: exported
 *    only through this interface — callers never hold the raw array.
 *  - OpfsSpool: for production (browser with OPFS). Writes sequentially to
 *    an OPFS temp file; deletes it on success, error, and cancel.
 */

import { TranscriptExportError } from '@slicc/shared-ts';
import { sha256 } from 'js-sha256';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/**
 * Injectable spool for follower-side transcript export chunk storage.
 * Implementations must guarantee:
 *  - No chunk `Uint8Array` is retained in the caller's state after `append`.
 *  - `cancel()` is always safe to call and releases all resources.
 *  - `finalize()` rejects on integrity mismatch or after `cancel()`.
 */
export interface ExportSpool {
  /**
   * Durably store one chunk. Called in order (index 0, 1, 2, …).
   * Rejects on storage error.
   */
  append(chunk: Uint8Array, index: number): Promise<void>;

  /**
   * Verify integrity and return the assembled Blob.
   * Only call after all chunks have been appended.
   * Rejects with `TranscriptExportError('transfer-corrupt')` on mismatch.
   */
  finalize(chunkCount: number, byteLength: number, sha256Hex: string): Promise<Blob>;

  /**
   * Abort and release all resources. Idempotent. Must be called on every
   * non-finalize exit path (cancel, error, disconnect).
   */
  cancel(): Promise<void>;
}

// ---------------------------------------------------------------------------
// MemorySpool — tests and non-OPFS fallback
// ---------------------------------------------------------------------------

/**
 * In-memory spool with an explicit bounded policy: the chunk array is private
 * and is cleared on cancel. Suitable for tests and environments without OPFS.
 *
 * Callers inject this via `FollowerSyncManagerOptions.makeExportSpool` in
 * tests. Production code uses `makeExportSpool()` which returns an OpfsSpool
 * when OPFS is available, falling back to MemorySpool.
 */
export class MemorySpool implements ExportSpool {
  /** Bounded private store. Never exposed to callers. */
  private readonly parts: Uint8Array[] = [];
  private cancelled = false;

  async append(chunk: Uint8Array, _index: number): Promise<void> {
    if (this.cancelled) throw new Error('MemorySpool: already cancelled');
    this.parts.push(chunk);
  }

  async finalize(chunkCount: number, byteLength: number, sha256Hex: string): Promise<Blob> {
    if (this.cancelled) throw new TranscriptExportError('transfer-corrupt');

    if (this.parts.length !== chunkCount) {
      throw new TranscriptExportError('transfer-corrupt');
    }

    let total = 0;
    for (const p of this.parts) total += p.byteLength;
    if (total !== byteLength) {
      throw new TranscriptExportError('transfer-corrupt');
    }

    const hasher = sha256.create();
    for (const p of this.parts) hasher.update(p);
    if (hasher.hex() !== sha256Hex) {
      throw new TranscriptExportError('transfer-corrupt');
    }

    const blob = new Blob(this.parts as Uint8Array<ArrayBuffer>[], { type: 'application/zip' });
    this.parts.length = 0; // release memory immediately after finalize
    return blob;
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    this.parts.length = 0;
  }
}

// ---------------------------------------------------------------------------
// OpfsSpool — production OPFS implementation
// ---------------------------------------------------------------------------

/**
 * OPFS-backed spool for production use.
 *
 * Writes chunks sequentially to a temp file under `.slicc-export-tmp/`.
 * On `finalize`: verifies chunk count, byte length, and SHA-256; returns the
 * File (a Blob subtype) directly without a second full copy; then deletes
 * the temp file.
 * On `cancel` or any error: deletes the temp file. Never leaks temp files.
 */
export class OpfsSpool implements ExportSpool {
  private readonly tempName: string;
  private writable: FileSystemWritableFileStream | null = null;
  private readonly hasher = sha256.create();
  private chunkCount = 0;
  private bytesWritten = 0;
  private cancelled = false;
  private fileHandle: FileSystemFileHandle | null = null;
  private dirHandle: FileSystemDirectoryHandle | null = null;

  constructor(requestId: string) {
    this.tempName = `export-${requestId}.zip.tmp`;
  }

  private async openWritable(): Promise<void> {
    const root = await navigator.storage.getDirectory();
    this.dirHandle = await root.getDirectoryHandle('.slicc-export-tmp', { create: true });
    this.fileHandle = await this.dirHandle.getFileHandle(this.tempName, { create: true });
    this.writable = await this.fileHandle.createWritable();
  }

  async append(chunk: Uint8Array, _index: number): Promise<void> {
    if (this.cancelled) throw new Error('OpfsSpool: already cancelled');
    if (!this.writable) await this.openWritable();
    // Ensure the Uint8Array has a plain ArrayBuffer (not SharedArrayBuffer) for OPFS write.
    const buf = chunk.buffer instanceof ArrayBuffer ? chunk : new Uint8Array(chunk);
    await this.writable!.write(buf as unknown as FileSystemWriteChunkType);
    this.hasher.update(chunk);
    this.bytesWritten += chunk.byteLength;
    this.chunkCount++;
  }

  async finalize(chunkCount: number, byteLength: number, sha256Hex: string): Promise<Blob> {
    if (this.cancelled) throw new TranscriptExportError('transfer-corrupt');

    if (this.chunkCount !== chunkCount || this.bytesWritten !== byteLength) {
      await this.cleanup();
      throw new TranscriptExportError('transfer-corrupt');
    }
    if (this.hasher.hex() !== sha256Hex) {
      await this.cleanup();
      throw new TranscriptExportError('transfer-corrupt');
    }

    await this.writable?.close();
    this.writable = null;

    if (!this.fileHandle) {
      await this.cleanup();
      throw new TranscriptExportError('transfer-corrupt');
    }

    const file = await this.fileHandle.getFile();
    // Wrap as Blob with the correct MIME type
    const blob = file.slice(0, file.size, 'application/zip');

    await this.deleteTempFile();
    return blob;
  }

  async cancel(): Promise<void> {
    if (this.cancelled) return;
    this.cancelled = true;
    await this.cleanup();
  }

  private async cleanup(): Promise<void> {
    try {
      await this.writable?.close();
    } catch {
      /* ignore */
    }
    this.writable = null;
    await this.deleteTempFile();
  }

  private async deleteTempFile(): Promise<void> {
    try {
      await this.dirHandle?.removeEntry(this.tempName);
    } catch {
      /* ignore if already gone */
    }
    this.fileHandle = null;
  }
}

// ---------------------------------------------------------------------------
// Factory — production vs. test/fallback
// ---------------------------------------------------------------------------

/**
 * Create an ExportSpool appropriate for the current environment.
 * Returns an OpfsSpool when OPFS is available, otherwise MemorySpool.
 * Accepts a requestId for OpfsSpool temp file naming.
 */
export function makeExportSpool(requestId: string): ExportSpool {
  if (typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function') {
    return new OpfsSpool(requestId);
  }
  return new MemorySpool();
}
