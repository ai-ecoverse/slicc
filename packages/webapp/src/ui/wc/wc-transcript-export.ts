/**
 * Local Blob/download helpers for transcript export.
 *
 * `transcriptZipToBlob` streams chunks from a TranscriptZipResult, verifies
 * the completion byte length before constructing the Blob, and throws
 * TranscriptExportError('transfer-corrupt') on mismatch.
 *
 * `downloadTranscriptBlob` creates a temporary anchor element, triggers a
 * browser download, then always revokes the object URL (finally block).
 */
import { TranscriptExportError } from '@slicc/shared-ts';
import type { TranscriptZipResult } from '../../transcript/zip-stream.js';

// ---------------------------------------------------------------------------
// Blob assembly
// ---------------------------------------------------------------------------

/**
 * Stream all chunks from `result`, await `completion`, verify byte length,
 * and return a Blob typed `application/zip`.
 *
 * Throws `TranscriptExportError('transfer-corrupt')` when the consumed byte
 * count does not match the completion receipt.
 */
export async function transcriptZipToBlob(result: TranscriptZipResult): Promise<Blob> {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;

  for await (const chunk of result.chunks) {
    chunks.push(chunk);
    byteLength += chunk.byteLength;
  }

  const completion = await result.completion;
  if (completion.byteLength !== byteLength) {
    throw new TranscriptExportError('transfer-corrupt');
  }

  return new Blob(chunks as Uint8Array<ArrayBuffer>[], { type: 'application/zip' });
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
