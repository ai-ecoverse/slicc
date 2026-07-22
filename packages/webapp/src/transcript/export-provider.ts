/**
 * Registration seam for the TranscriptExportService.
 *
 * A single module-level provider slot that can be registered from either the
 * worker side (Orchestrator.init) or the page side (WC live boot). The
 * teardown function returned by `registerTranscriptExportService` only clears
 * its own instance, so a late teardown cannot evict a newer registration.
 *
 * Usage:
 *   const teardown = registerTranscriptExportService(myService);
 *   ...
 *   teardown(); // safe even if another service has since been registered
 */
import { TranscriptExportError } from '@slicc/shared-ts';
import type { TranscriptExportService } from './export-service.js';

// ---------------------------------------------------------------------------
// Module-level provider slot
// ---------------------------------------------------------------------------

let provider: TranscriptExportService | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register the given `service` as the active `TranscriptExportService`.
 *
 * Returns a teardown function that, when called, clears the provider **only
 * if it is still the same instance** — preventing a stale teardown from
 * evicting a freshly-registered replacement.
 */
export function registerTranscriptExportService(service: TranscriptExportService): () => void {
  provider = service;
  return () => {
    if (provider === service) provider = null;
  };
}

/**
 * Return the currently registered `TranscriptExportService`.
 *
 * Throws `TranscriptExportError('session-not-found')` when no service has
 * been registered — callers should handle this by informing the user that
 * the export service is not yet available.
 */
export function getTranscriptExportService(): TranscriptExportService {
  if (!provider) throw new TranscriptExportError('session-not-found');
  return provider;
}
