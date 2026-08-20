/**
 * Local Blob/download helpers for transcript export, plus the leader-side
 * approval dialog and ZIP factory for tray follower export requests.
 *
 * - `transcriptZipToBlob`: streams + verifies a TranscriptZipResult.
 * - `downloadTranscriptBlob`: anchor-based browser download.
 * - `openTranscriptExportApproval`: shows a slicc-dialog with Allow/Deny.
 * - `runTranscriptExportForFollower`: creates a ZIP for an approved follower
 *   export using the registered TranscriptExportService.
 */
import type { TranscriptExportSelector } from '@slicc/shared-ts';
import { makeExportSpool } from '../../transcript/export-spool.js';
import type { TranscriptZipResult } from '../../transcript/zip-stream.js';
import type { OffscreenClient } from '../offscreen-client.js';

// ---------------------------------------------------------------------------
// Blob assembly
// ---------------------------------------------------------------------------

/**
 * Stream all chunks from `result` into an ExportSpool (OPFS-backed in
 * production, MemorySpool fallback), verify via the completion receipt,
 * and return the assembled Blob typed `application/zip`.
 *
 * Using makeExportSpool here keeps the local export path consistent with
 * the follower path: large exports are written to an OPFS temp file rather
 * than accumulated in a JS heap array, bounding peak memory usage.
 *
 * Throws `TranscriptExportError('transfer-corrupt')` on byte-length or
 * SHA-256 mismatch (delegated to spool.finalize).
 */
export async function transcriptZipToBlob(result: TranscriptZipResult): Promise<Blob> {
  const spool = makeExportSpool(`local-${crypto.randomUUID()}`);
  try {
    let idx = 0;
    for await (const chunk of result.chunks) {
      await spool.append(chunk, idx++);
    }
    const completion = await result.completion;
    // spool.finalize verifies byteLength + SHA-256 and returns the Blob.
    return await spool.finalize(idx, completion.byteLength, completion.sha256);
  } catch (err) {
    // Cancel releases any OPFS temp file before re-throwing.
    await spool.cancel();
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Browser download
// ---------------------------------------------------------------------------

/**
 * Download a Blob using a temporary anchor element.
 *
 * - Creates and appends the anchor (marked with `data-transcript-dl` for
 *   test cleanup).
 * - Clicks the anchor to trigger the browser's save dialog.
 * - Removes the anchor and revokes the object URL in a finally block so
 *   the URL is always released even if click throws.
 *
 * May rethrow errors from `anchor.click()` after cleanup has completed.
 * Callers that need to suppress click-related errors must catch them.
 */
export async function downloadTranscriptBlob(blob: Blob, filename: string): Promise<void> {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.setAttribute('data-transcript-dl', '');
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    URL.revokeObjectURL(url);
  }
}

// ---------------------------------------------------------------------------
// Leader approval dialog
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Leader-side ZIP factory for follower exports
// ---------------------------------------------------------------------------

/**
 * Create a TranscriptZipResult for an approved follower export.
 * Uses the registered TranscriptExportService (same one that the local
 * avatar-menu export uses), passing the selector and abort signal.
 */
export async function runTranscriptExportForFollower(
  selector: TranscriptExportSelector,
  signal: AbortSignal,
  _client: OffscreenClient
): Promise<TranscriptZipResult> {
  const { getTranscriptExportService } = await import('../../transcript/export-provider.js');
  const svc = getTranscriptExportService();
  const svcSelector =
    selector.kind === 'frozen'
      ? { kind: 'frozen' as const, sessionId: selector.sessionId }
      : { kind: 'active' as const };
  return svc.export(svcSelector, { signal });
}
