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
import type { DirEntry } from '../fs/types.js';
import type { WritableVfsClient } from '../kernel/writable-vfs-client.js';
import { getDailyAdobeUuid } from '../scoops/llm-session-id.js';
import { getApiKey, resolveCurrentModel } from './provider-settings.js';
import {
  enrichPendingSession,
  type FrozenSession,
  type FrozenSessionIndexEntry,
  freezeConeSession,
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

/**
 * Default race window (ms) the single-click "save" path waits for LLM
 * enrichment before clearing the chat and letting enrichment finish in the
 * background. The durable archive is already on disk at t=0, so this only
 * bounds how long the user watches the spinner — never data safety.
 */
const DEFAULT_ENRICHMENT_RACE_MS = 20_000;

/** How often the race timer reports progress (ms) to drive the spinner ring. */
const ENRICHMENT_PROGRESS_TICK_MS = 250;

export interface RunNewSessionFreezeOptions {
  /**
   * Writable VFS handle. Under `slicc_opfs_vfs === 'opfs'` AND on the
   * OPFS-leader tab, callers pass a `RemoteWritableVfsClient` so
   * writes route to the worker's `VfsRpcHost` (canonical OPFS store).
   * With the flag off the existing page-side `VirtualFS` satisfies
   * the same shape structurally.
   */
  vfs: WritableVfsClient;
  /**
   * Race window in ms: how long to wait for LLM enrichment before resolving
   * (so the caller can clear the chat) and continuing enrichment in the
   * background. Injectable so tests don't block on the real 20s timer.
   * Defaults to {@link DEFAULT_ENRICHMENT_RACE_MS}.
   */
  enrichmentRaceMs?: number;
  /**
   * Progress callback driven by the race timer: a 0..1 fraction of the race
   * window elapsed, then `null` once the race resolves (LLM done or timer
   * fired). The freezer button maps this to its busy/progress ring.
   */
  onProgress?: (fraction: number | null) => void;
  /**
   * Fired once background enrichment (the timer-won path) finally resolves,
   * with the updated index entry (or `null` if it stayed pending). Lets the
   * caller refresh the freezer rail when the rename + icon land late.
   */
  onBackgroundEnriched?: (entry: FrozenSessionIndexEntry | null) => void;
}

type NewSessionTmpVfs = Pick<WritableVfsClient, 'mkdir' | 'readDir' | 'rm'>;

async function removeDirectoryEntries(
  vfs: NewSessionTmpVfs,
  parentPath: string,
  entries: DirEntry[]
): Promise<void> {
  for (const entry of entries) {
    const childPath = `${parentPath}/${entry.name}`;
    if (entry.type === 'directory') {
      await removeDirectoryEntries(vfs, childPath, await vfs.readDir(childPath));
    }
    await vfs.rm(childPath);
  }
}

/** Remove all shared scratch data while leaving `/tmp` ready for the next session. */
export async function resetNewSessionTmp(vfs: NewSessionTmpVfs): Promise<void> {
  let entries: DirEntry[];
  try {
    entries = await vfs.readDir('/tmp');
  } catch (err) {
    if ((err as { code?: string } | null)?.code !== 'ENOENT') throw err;
    await vfs.mkdir('/tmp', { recursive: true });
    return;
  }
  await removeDirectoryEntries(vfs, '/tmp', entries);
  await vfs.mkdir('/tmp', { recursive: true });
}

/** Outcome of the enrichment-vs-timer race. */
type EnrichmentRaceResult =
  | { kind: 'llm'; updated: FrozenSessionIndexEntry | null }
  | { kind: 'timer' };

/**
 * Single-click "save" freeze — robust against LLM provider outages.
 *
 * 1. **Write first.** Quick-freeze the cone session to a durable
 *    `pending-<id>.md` archive BEFORE any LLM call, so a hung provider can
 *    never lose the conversation.
 * 2. **Enrich + race.** Start the combined memory → title → icon enrichment
 *    over the just-written archive and race it against a {@link
 *    DEFAULT_ENRICHMENT_RACE_MS} timer that also drives the spinner progress.
 * 3. **LLM wins (< race window):** apply enrichment synchronously and return
 *    the fully-enriched entry — the chat clears at LLM-done.
 * 4. **Timer wins:** return the (still-pending) entry so the caller clears the
 *    chat now; enrichment continues in the background and `onBackgroundEnriched`
 *    fires with the renamed entry once it resolves.
 *
 * Returns the frozen entry (pending or enriched), or `null` when nothing was
 * archived (short session / write failure). Never throws.
 */
export async function runNewSessionFreeze(
  opts: RunNewSessionFreezeOptions
): Promise<FrozenSession | null> {
  const raceMs = opts.enrichmentRaceMs ?? DEFAULT_ENRICHMENT_RACE_MS;

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

  // 1. WRITE FIRST — durable archive on disk before any LLM call.
  const frozen = await freezeConeSession({
    sessionStore,
    vfs: opts.vfs,
    mode: 'quick',
  });
  if (!frozen) return null; // short session / write failure — nothing to do.

  // No credentials → nothing to enrich now; leave a durable
  // `pending-*.md` archive. Auto-finish was removed (see #1226);
  // re-saving once a provider is configured will run enrichment.
  if (!apiKey || !model) {
    log.info('Frozen without enrichment (no LLM credentials) — left pending', {
      filename: frozen.filename,
    });
    return frozen;
  }

  // 2. Start the combined enrichment (memory → title → icon) over the
  //    already-written pending archive. Best-effort — never throws.
  const enrichModel = model;
  const enrichment = enrichPendingSession(opts.vfs, frozen, {
    model: enrichModel,
    apiKey,
    headers,
    pickIcon: (iconOpts) =>
      import('../providers/quick-llm.js').then(({ pickLucideIcon }) => pickLucideIcon(iconOpts)),
  }).catch((err) => {
    log.warn('Single-click enrichment threw (entry stays pending)', {
      filename: frozen.filename,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  });

  // 3 + 4. Race enrichment against the timer, driving the spinner progress.
  const winner = await raceEnrichmentAgainstTimer(enrichment, raceMs, opts.onProgress);

  if (winner.kind === 'llm') {
    // LLM won (< raceMs): enrichment already applied; return the enriched entry.
    return winner.updated ? { ...winner.updated, archive: frozen.archive } : frozen;
  }

  // Timer won: the archive is durable, so the caller may clear the chat now.
  // Let enrichment finish in the background and notify the caller so the rail
  // can refresh once the rename + icon land.
  void enrichment.then((updated) => {
    log.info('Background enrichment resolved after race window', {
      filename: frozen.filename,
      enriched: updated?.filename ?? null,
    });
    opts.onBackgroundEnriched?.(updated);
  });
  return frozen;
}

/**
 * Race the enrichment promise against a timer, reporting 0..1 progress on a
 * fixed tick so the freezer spinner can render a countdown ring. Always
 * clears both timers and emits a final `null` progress on resolution.
 */
async function raceEnrichmentAgainstTimer(
  enrichment: Promise<FrozenSessionIndexEntry | null>,
  raceMs: number,
  onProgress?: (fraction: number | null) => void
): Promise<EnrichmentRaceResult> {
  const start = Date.now();
  let progressTimer: ReturnType<typeof setInterval> | undefined;
  let raceTimer: ReturnType<typeof setTimeout> | undefined;

  onProgress?.(0);
  if (onProgress) {
    progressTimer = setInterval(() => {
      onProgress(Math.min(1, (Date.now() - start) / raceMs));
    }, ENRICHMENT_PROGRESS_TICK_MS);
  }
  const timer = new Promise<EnrichmentRaceResult>((resolve) => {
    raceTimer = setTimeout(() => resolve({ kind: 'timer' }), raceMs);
  });
  const llm = enrichment.then((updated): EnrichmentRaceResult => ({ kind: 'llm', updated }));

  try {
    return await Promise.race([llm, timer]);
  } finally {
    if (progressTimer) clearInterval(progressTimer);
    if (raceTimer) clearTimeout(raceTimer);
    onProgress?.(null);
  }
}

/**
 * Quick-freeze variant of `runNewSessionFreeze`. Skips the two LLM calls
 * (and therefore the credential/header resolution they need), writing
 * the cone session under a synthetic `pending-…md` filename with the
 * heuristic title. The archive is durable but **never enriched** — the
 * entry stays with its heuristic title and no icon. Designed for the
 * double-click "impatient" gesture where reload latency matters more
 * than archive title fidelity.
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
