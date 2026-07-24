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

/**
 * Show a one-use approval dialog for a follower transcript export request.
 * Returns true (Allow once) or false (Deny / Escape / close).
 *
 * The dialog shows only the safe metadata the leader already knows from its
 * own connected state: follower label, selector, and estimated size.
 * No transcript title or content is revealed before approval.
 */
export function openTranscriptExportApproval(request: {
  requestId: string;
  followerLabel: string;
  hostOrigin?: string;
  selector: TranscriptExportSelector;
  estimatedBytes?: number;
}): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const dialog = document.createElement('slicc-dialog');
    dialog.setAttribute('heading', 'Export transcript request');

    const body = document.createElement('div');
    body.style.cssText = 'display:flex;flex-direction:column;gap:0.75rem;padding:0.25rem 0;';

    const row = (label: string, value: string): HTMLElement => {
      const el = document.createElement('div');
      el.style.cssText = 'display:grid;grid-template-columns:8rem 1fr;gap:0.5rem;';
      const lbl = document.createElement('span');
      lbl.style.cssText = 'color:var(--s2-content-secondary,#717171);font-size:0.875rem;';
      lbl.textContent = label;
      const val = document.createElement('span');
      val.style.cssText = 'font-size:0.875rem;word-break:break-word;';
      val.textContent = value;
      el.append(lbl, val);
      return el;
    };

    body.append(row('Follower', request.followerLabel));
    if (request.hostOrigin) body.append(row('Host origin', request.hostOrigin));
    body.append(
      row(
        'Transcript',
        request.selector.kind === 'frozen'
          ? `Archived session (${request.selector.sessionId})`
          : 'Active session'
      )
    );
    if (request.estimatedBytes != null) {
      const kb = Math.round(request.estimatedBytes / 1024);
      body.append(row('Est. size', `${kb} KB`));
    }

    const warning = document.createElement('p');
    warning.style.cssText =
      'font-size:0.8125rem;color:var(--s2-content-secondary,#717171);margin:0;';
    warning.textContent =
      '\u26a0\ufe0f The follower will receive a complete binary copy of the transcript. ' +
      'This is a one-time approval — export starts immediately after you click Allow.';
    body.append(warning);
    dialog.append(body);

    const makeBtn = (text: string, primary: boolean, onClick: () => void): HTMLButtonElement => {
      const btn = document.createElement('button');
      btn.textContent = text;
      btn.setAttribute('slot', 'footer');
      btn.style.cssText = primary
        ? 'padding:0.5rem 1.25rem;border-radius:0.375rem;border:none;cursor:pointer;' +
          'background:var(--s2-accent-color,#0265dc);color:#fff;font-size:0.875rem;'
        : 'padding:0.5rem 1.25rem;border-radius:0.375rem;cursor:pointer;' +
          'background:transparent;border:1px solid var(--s2-border-color,#e0e0e0);font-size:0.875rem;';
      btn.addEventListener('click', onClick, { once: true });
      return btn;
    };

    let resolved = false;
    const settle = (allow: boolean): void => {
      if (resolved) return;
      resolved = true;
      (dialog as HTMLElement & { hide?: () => void }).hide?.();
      resolve(allow);
    };

    dialog.append(makeBtn('Allow once', true, () => settle(true)));
    dialog.append(makeBtn('Deny', false, () => settle(false)));

    dialog.addEventListener('slicc-dialog-close', () => {
      dialog.remove();
      settle(false);
    });

    document.body.append(dialog);
    (dialog as HTMLElement & { show?: () => void }).show?.();
  });
}

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
