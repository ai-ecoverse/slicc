/**
 * Cherry-local transcript export types.
 *
 * Duplicated (not imported) from @slicc/shared-ts to keep Cherry dependency-light
 * and avoid importing @slicc/webapp.  Keep the shapes in sync with
 * packages/shared-ts/src/transcript-export.ts.
 */

export type TranscriptExportErrorCode =
  | 'permission-denied'
  | 'redaction-unavailable'
  | 'session-not-found'
  | 'transfer-aborted'
  | 'transfer-corrupt'
  | 'schema-invalid'
  | 'attachment-unreadable';

export class TranscriptExportError extends Error {
  constructor(public readonly code: TranscriptExportErrorCode) {
    super(code);
    this.name = 'TranscriptExportError';
  }
}

export interface TranscriptExportProgress {
  phase:
    | 'waiting-for-conversations'
    | 'collecting'
    | 'redacting'
    | 'packaging'
    | 'transferring'
    | 'complete';
  processedBytes?: number;
  estimatedBytes?: number;
}

export interface ExportSessionOptions {
  /**
   * Which session to export. `'active'` (default) exports the currently open
   * session; a frozen session ID exports a past session.
   */
  sessionId?: 'active' | string;
  /** Optional AbortSignal to cancel the in-flight export. */
  signal?: AbortSignal;
  /** Called as the follower advances through export phases. */
  onProgress?: (progress: TranscriptExportProgress) => void;
}
