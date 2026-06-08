/**
 * "New session" orchestration — UI-side glue that resolves model/api-key
 * and invokes the freezer over the cone's current chat session.
 *
 * Both the extension and standalone (kernel-worker) paths wire their
 * `onClearChat` to call `runNewSessionFreeze`, so the freezer behavior
 * stays in one place.
 */

import type { Api, Model } from '@earendil-works/pi-ai';
import { createLogger } from '../core/logger.js';
import type { WritableVfsClient } from '../kernel/writable-vfs-client.js';
import { getDailyAdobeUuid } from '../scoops/llm-session-id.js';
import { getApiKey, resolveCurrentModel } from './provider-settings.js';
import {
  enrichPendingSession,
  type FrozenSession,
  type FrozenSessionIndexEntry,
  freezeConeSession,
  listPendingEnrichments,
} from './session-freezer.js';
import { SessionStore } from './session-store.js';

const log = createLogger('new-session');

/**
 * Freezer-specific Adobe `X-Session-Id` anchor. Grouping freezer traffic
 * under its own anchor keeps it visible-but-distinct from ad-hoc UI label
 * calls in proxy monitoring, while still rotating daily and never leaking
 * scoop/folder identifiers.
 */
const FREEZER_SESSION_ANCHOR = 'ui-new-session';

export interface RunNewSessionFreezeOptions {
  /**
   * Writable VFS handle. Under `slicc_opfs_vfs === 'opfs'` AND on the
   * OPFS-leader tab, callers pass a `RemoteWritableVfsClient` so
   * writes route to the worker's `VfsRpcHost` (canonical OPFS store).
   * With the flag off the existing page-side `VirtualFS` satisfies
   * the same shape structurally.
   */
  vfs: WritableVfsClient;
}

/**
 * Resolve credentials + model + headers, then run the freezer. Returns the
 * frozen entry on success, `null` when nothing was archived (short session,
 * missing creds, or write failure). Never throws.
 */
export async function runNewSessionFreeze(
  opts: RunNewSessionFreezeOptions
): Promise<FrozenSession | null> {
  const apiKey = getApiKey() ?? undefined;
  let model: Model<Api> | undefined;
  try {
    model = resolveCurrentModel();
  } catch (err) {
    log.info('No active model — freezing without LLM enrichment', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const headers: Record<string, string> | undefined =
    model?.provider === 'adobe'
      ? { 'X-Session-Id': getDailyAdobeUuid(FREEZER_SESSION_ANCHOR) }
      : undefined;

  const sessionStore = new SessionStore();
  try {
    await sessionStore.init();
  } catch (err) {
    log.warn('SessionStore init failed — cannot freeze', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  return freezeConeSession({
    sessionStore,
    vfs: opts.vfs,
    model,
    apiKey,
    headers,
  });
}

/**
 * Quick-freeze variant of `runNewSessionFreeze`. Skips the two LLM calls
 * (and therefore the credential/header resolution they need), writing
 * the cone session under a synthetic `pending-…md` filename with the
 * heuristic title. Boot-time enrichment finishes the work later via
 * `enrichPendingSessions`. Returns as quickly as the VFS write + index
 * update allow — designed for the double-click "impatient" gesture
 * where reload latency matters more than archive title fidelity.
 */
export async function runNewSessionFreezeQuick(
  opts: RunNewSessionFreezeOptions
): Promise<FrozenSession | null> {
  const sessionStore = new SessionStore();
  try {
    await sessionStore.init();
  } catch (err) {
    log.warn('SessionStore init failed — cannot quick-freeze', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  return freezeConeSession({
    sessionStore,
    vfs: opts.vfs,
    mode: 'quick',
  });
}

export interface EnrichPendingSessionsResult {
  /** Total pending entries found in the index. */
  found: number;
  /** Entries successfully enriched (title rewritten + file renamed). */
  enriched: FrozenSessionIndexEntry[];
}

/**
 * Resolve credentials + model + headers once, then walk the sessions
 * index and finish every `pendingEnrichment: true` archive. Designed
 * to be fire-and-forget from boot — never throws, and best-effort per
 * entry so one bad archive doesn't block the rest. When no LLM
 * credentials are available, this is a no-op (entries stay pending and
 * will be retried on the next boot once credentials are configured).
 */
export async function enrichPendingSessions(
  opts: RunNewSessionFreezeOptions
): Promise<EnrichPendingSessionsResult> {
  const result: EnrichPendingSessionsResult = { found: 0, enriched: [] };

  let pending: FrozenSessionIndexEntry[] = [];
  try {
    pending = await listPendingEnrichments(opts.vfs);
  } catch (err) {
    log.warn('Failed to list pending enrichments', {
      error: err instanceof Error ? err.message : String(err),
    });
    return result;
  }
  result.found = pending.length;
  if (pending.length === 0) return result;

  const apiKey = getApiKey() ?? undefined;
  let model: Model<Api> | undefined;
  try {
    model = resolveCurrentModel();
  } catch (err) {
    log.info('No active model — skipping background enrichment', {
      error: err instanceof Error ? err.message : String(err),
    });
    return result;
  }
  if (!apiKey || !model) {
    log.info('LLM credentials unavailable — leaving pending entries for later boot', {
      pending: pending.length,
    });
    return result;
  }

  const headers: Record<string, string> | undefined =
    model.provider === 'adobe'
      ? { 'X-Session-Id': getDailyAdobeUuid(FREEZER_SESSION_ANCHOR) }
      : undefined;

  for (const entry of pending) {
    try {
      const updated = await enrichPendingSession(opts.vfs, entry, {
        model,
        apiKey,
        headers,
      });
      if (updated) result.enriched.push(updated);
    } catch (err) {
      log.warn('Background enrichment threw (entry stays pending)', {
        filename: entry.filename,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info('Background enrichment pass complete', {
    found: result.found,
    enriched: result.enriched.length,
  });
  return result;
}

/**
 * Schedule a fire-and-forget background enrichment pass over pending
 * frozen sessions (those archived by the impatient double-click path).
 * Defers via `requestIdleCallback` where available so a slow LLM call
 * can't delay first paint; falls back to `setTimeout(0)` otherwise.
 * Never throws — `enrichPendingSessions` is already best-effort.
 *
 * Callers pass `isWriter: false` for non-leader tabs under
 * `slicc_opfs_vfs === 'opfs'`. Enrichment writes go via the supplied
 * VFS; on a follower that VFS is the page-side LFS shadow which the
 * worker-OPFS-backed UI never reads → silent orphan. Skip the pass
 * entirely on followers (read-only mode), matching the read-only
 * banner.
 */
export function scheduleBackgroundEnrichment(
  vfs: WritableVfsClient,
  opts: { isWriter?: boolean } = {}
): void {
  if (opts.isWriter === false) {
    log.info('Background enrichment skipped (OPFS follower — read-only tab)');
    return;
  }
  const run = (): void => {
    void enrichPendingSessions({ vfs }).catch(() => {
      // `enrichPendingSessions` already logs internally and is best-effort
      // per entry; swallow here so the boot path stays silent on failure.
    });
  };
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void) => number })
    .requestIdleCallback;
  if (typeof ric === 'function') {
    ric(run);
  } else {
    setTimeout(run, 0);
  }
}
