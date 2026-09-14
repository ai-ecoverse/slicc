import { TranscriptExportError, type TranscriptExportSelector } from '@slicc/shared-ts';
import { makeExportSpool } from '../../transcript/export-spool.js';
import type { TranscriptZipResult } from '../../transcript/zip-stream.js';
import type { OffscreenClient } from '../offscreen-client.js';

export async function transcriptZipToBlob(result: TranscriptZipResult): Promise<Blob> {
  const spool = makeExportSpool(`local-${crypto.randomUUID()}`);
  try {
    let idx = 0;
    for await (const chunk of result.chunks) {
      await spool.append(chunk, idx++);
    }
    const completion = await result.completion;

    return await spool.finalize(idx, completion.byteLength, completion.sha256);
  } catch (err) {
    await spool.cancel();
    throw err;
  }
}

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

function exportFailureReason(err: unknown): string {
  if (err instanceof TranscriptExportError) {
    return err.detail ? `${err.code}: ${err.detail}` : err.code;
  }
  return err instanceof Error && err.message ? err.message : 'unknown error';
}

export function showTranscriptExportFailure(err: unknown): void {
  if (typeof document === 'undefined' || !customElements.get('slicc-dialog')) return;
  const dialog = document.createElement('slicc-dialog') as HTMLElement & { show?: () => void };
  dialog.setAttribute('heading', 'Export failed');

  const body = document.createElement('p');
  body.style.cssText = 'margin:0;padding:0.25rem 0;font-size:0.9375rem;line-height:1.5;';
  body.textContent = `No transcript was written — ${exportFailureReason(err)}.`;
  dialog.append(body);

  const close = document.createElement('button');
  close.setAttribute('slot', 'footer');
  close.type = 'button';
  close.dataset.transcriptExportAction = 'close';
  close.textContent = 'Close';
  close.addEventListener('click', () => dialog.remove());
  dialog.append(close);

  dialog.addEventListener('slicc-dialog-close', () => dialog.remove());
  document.body.appendChild(dialog);
  dialog.show?.();
}

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
