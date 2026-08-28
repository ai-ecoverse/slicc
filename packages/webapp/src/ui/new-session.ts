/**
 * "New session" orchestration — UI-side glue that resolves model/api-key
 * and invokes the freezer over the selected cone's current chat session.
 *
 * Both the extension and standalone (kernel-worker) paths wire their
 * `onClearChat` to call `runNewSessionFreeze`, so the freezer behavior
 * stays in one place.
 */

import type { Api, Model } from '@earendil-works/pi-ai';
import { createLogger } from '../base/logger.js';
import { isFeatureEnabled } from '../core/feature-flags.js';
import type { DirEntry } from '../fs/types.js';
import type { WritableVfsClient } from '../kernel/writable-vfs-client.js';
import type { AgentBridge } from '../scoops/agent-bridge.js';
import { SessionStore } from '../scoops/chat-session-store.js';
import { getDailyAdobeUuid } from '../scoops/llm-session-id.js';
import { getApiKey, resolveCurrentModel } from './provider-settings.js';
import {
  curateFrozenSessionMemories,
  enrichPendingSession,
  type FreezerConeRef,
  type FrozenSession,
  type FrozenSessionIndexEntry,
  freezeConeSession,
  markSnapshotUnavailable,
  processPendingSessions,
} from './session-freezer.js';

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

export interface PendingSessionCatchupOptions {
  openVfs: () => Promise<WritableVfsClient>;
  onComplete?: () => void;
  schedule?: (callback: () => void) => void;
}

/**
 * Run the boot catch-up for archives whose inline enrichment never finished.
 *
 * Deliberately drives only the legacy single-call enrichment. A curator pass is
 * an unbounded multi-turn agent run — one measured pass billed $53.81 over 163
 * turns and 30 minutes, and `timeoutSeconds` cannot stop it because
 * `AgentSpawnOptions` has no cancellation path. Retrying that automatically on
 * every boot multiplies the bill, so `memoryPending` archives are left for the
 * next freeze to pick up instead.
 */
export async function runPendingSessionCatchup(opts: PendingSessionCatchupOptions): Promise<void> {
  try {
    const vfs = await opts.openVfs();
    const apiKey = getApiKey() ?? undefined;
    if (!apiKey) return;
    let model: Model<Api>;
    try {
      model = resolveCurrentModel();
    } catch {
      return;
    }
    const headers =
      model.provider === 'adobe'
        ? { 'X-Session-Id': getDailyAdobeUuid(FREEZER_SESSION_ANCHOR) }
        : undefined;
    await processPendingSessions({ vfs, model, apiKey, headers });
    opts.onComplete?.();
  } catch (err) {
    log.warn('Pending session catch-up failed (boot continues)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Schedule catch-up after first paint without returning a boot-blocking promise. */
export function schedulePendingSessionCatchup(opts: PendingSessionCatchupOptions): void {
  const schedule = opts.schedule ?? scheduleIdle;
  schedule(() => {
    void runPendingSessionCatchup(opts);
  });
}

function scheduleIdle(callback: () => void): void {
  if (typeof globalThis.requestIdleCallback === 'function') {
    globalThis.requestIdleCallback(callback, { timeout: 5_000 });
    return;
  }
  setTimeout(callback, 0);
}

function resolveAgenticMemorySpawn(
  opts: RunNewSessionFreezeOptions
): AgentBridge['spawn'] | undefined {
  if (!isFeatureEnabled('agentic-memory')) return undefined;
  if (!opts.agenticMemorySpawn) {
    log.info('Agentic memory enabled but agent bridge unavailable — using legacy enrichment');
    return undefined;
  }
  return opts.agenticMemorySpawn;
}

/**
 * Agentic freeze: snapshot fast, clear fast, curate in the background.
 *
 * 1. **Quick snapshot.** A `mode: 'quick'` freeze (heuristic title, no LLM
 *    calls) writes the durable `pending-…md` draft carrying BOTH markers:
 *    `pendingEnrichment` (title/icon still heuristic) and `memoryPending`
 *    (curator still owed). A reload at any later point leaves a recoverable
 *    entry for the boot catch-up.
 * 2. **Return immediately.** The caller clears the chat as soon as the
 *    archive is durable — no enrichment race, no waiting on the curator.
 * 3. **Background pass.** Title + icon enrichment (`skipMemory` — the
 *    curator owns memory) renames the draft, then the curator agent runs
 *    over the renamed archive. `onBackgroundEnriched` fires after each step
 *    so the freezer rail refreshes as results land.
 */
async function runAgenticMemoryFreeze(
  opts: RunNewSessionFreezeOptions,
  sessionStore: SessionStore,
  model: Model<Api>,
  apiKey: string,
  headers: Record<string, string> | undefined,
  spawn: AgentBridge['spawn']
): Promise<FrozenSession | null> {
  const frozen = await freezeConeSession({
    sessionStore,
    vfs: opts.vfs,
    mode: 'quick',
    agenticMemorySpawn: spawn,
    cone: opts.cone,
  });
  if (!frozen) return null;
  if (opts.captureCompleteSnapshot) {
    try {
      await opts.captureCompleteSnapshot(frozen);
    } catch (err) {
      const code = (err as { code?: string } | null)?.code ?? 'unknown';
      log.warn('captureCompleteSnapshot failed', { code });
      frozen.completeSnapshotUnavailable = true;
      try {
        await markSnapshotUnavailable(opts.vfs, frozen.filename);
      } catch {
        // Best-effort — the Markdown archive is still present.
      }
    }
  }
  void runAgenticBackgroundPass(opts, sessionStore, model, apiKey, headers, spawn, frozen);
  return frozen;
}

/**
 * Background half of the agentic freeze — runs entirely after the caller has
 * cleared the chat. Best-effort end to end: a failed title enrichment leaves
 * the pending draft for the boot catch-up; a failed curator leaves
 * `memoryPending` for the same. Never throws.
 */
async function runAgenticBackgroundPass(
  opts: RunNewSessionFreezeOptions,
  sessionStore: SessionStore,
  model: Model<Api>,
  apiKey: string,
  headers: Record<string, string> | undefined,
  spawn: AgentBridge['spawn'],
  frozen: FrozenSession
): Promise<void> {
  // Title + icon first (two bounded LLM calls, seconds): the rail shows the
  // real name long before the multi-turn curator finishes, and the curator
  // then mines the archive under its canonical filename.
  let current: FrozenSession = frozen;
  try {
    const updated = await enrichPendingSession(opts.vfs, frozen, {
      model,
      apiKey,
      headers,
      skipMemory: true,
      pickIcon: (iconOpts) =>
        import('../providers/quick-llm.js').then(({ pickLucideIcon }) => pickLucideIcon(iconOpts)),
    });
    if (updated) {
      current = { ...updated, archive: frozen.archive };
      opts.onBackgroundEnriched?.(updated);
    }
  } catch (err) {
    log.warn('Agentic title enrichment threw (draft stays pending)', {
      filename: frozen.filename,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const curated = await curateFrozenSessionMemories(
    {
      sessionStore,
      vfs: opts.vfs,
      mode: 'full',
      model,
      apiKey,
      headers,
      agenticMemorySpawn: spawn,
      cone: opts.cone,
    },
    current
  ).catch((err) => {
    log.warn('Agentic memory curator threw (entry stays pending)', {
      filename: current.filename,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  });
  log.info('Agentic memory curator finished', {
    filename: current.filename,
    memoryPending: curated ? curated.memoryPending === true : true,
  });
  opts.onBackgroundEnriched?.(curated);
}

export interface RunNewSessionFreezeOptions {
  /**
   * Writable VFS handle. Under `slicc_opfs_vfs === 'opfs'` AND on the
   * OPFS-leader tab, callers pass a `RemoteWritableVfsClient` so
   * writes route to the worker's `VfsRpcHost` (canonical OPFS store).
   * With the flag off the existing page-side `VirtualFS` satisfies
   * the same shape structurally.
   */
  vfs: WritableVfsClient;
  /** Page→kernel spawn seam. Omit it to preserve the legacy enrichment path. */
  agenticMemorySpawn?: AgentBridge['spawn'];
  /**
   * Race window in ms: how long to wait for LLM enrichment before resolving
   * (so the caller can clear the chat) and continuing enrichment in the
   * background. Injectable so tests don't block on the real 20s timer.
   * Defaults to {@link DEFAULT_ENRICHMENT_RACE_MS}. Legacy path only — the
   * agentic path resolves as soon as the quick snapshot is durable.
   */
  enrichmentRaceMs?: number;
  /**
   * Progress callback driven by the race timer: a 0..1 fraction of the race
   * window elapsed, then `null` once the race resolves (LLM done or timer
   * fired). The freezer button maps this to its busy/progress ring. Legacy
   * path only — the agentic path never waits, so it drives no progress ring.
   */
  onProgress?: (fraction: number | null) => void;
  /**
   * Fired once background enrichment (the timer-won path) finally resolves,
   * with the updated index entry (or `null` if it stayed pending). Lets the
   * caller refresh the freezer rail when the rename + icon land late.
   */
  onBackgroundEnriched?: (entry: FrozenSessionIndexEntry | null) => void;
  /**
   * Non-blocking hook called after the Markdown archive write succeeds and
   * before the caller clears histories. Used to produce and persist the full
   * sanitized transcript snapshot (JSON + redacted attachments).
   *
   * Failures are caught, the error code is logged, and the index entry is
   * updated with `completeSnapshotUnavailable: true`. The Markdown archive
   * is always retained; this hook never writes a raw fallback.
   */
  captureCompleteSnapshot?: (frozen: FrozenSession) => Promise<void>;
  /**
   * Which cone's chat to freeze (#2272). The freezer defaults to the primary
   * cone when omitted, so callers that predate multiple cones are unchanged;
   * the WC rail passes the currently selected root.
   */
  cone?: FreezerConeRef;
}

type NewSessionTmpVfs = Pick<WritableVfsClient, 'listMountPoints' | 'mkdir' | 'readDir' | 'rm'>;

/**
 * `true` when a VFS error says the entry is already gone — which is the goal
 * state of a delete, not a failure.
 *
 * The sweep is inherently racy: `/tmp` is shared scratch, so a sibling cone or
 * a scoop can remove an entry between our `readDir` and our `rm`. A real case:
 * a cone running `npm install` under `/tmp/rv` deleted
 * `…/ajv/dist/refs/json-schema-secure.json` mid-sweep and the resulting ENOENT
 * aborted the whole "New chat". Anything other than ENOENT (EIO, EPERM) is a
 * genuine fault and still propagates.
 */
function isAlreadyGone(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'ENOENT';
}

async function removeDirectoryEntries(
  vfs: NewSessionTmpVfs,
  parentPath: string,
  entries: DirEntry[],
  mountRoots: Set<string>
): Promise<void> {
  for (const entry of entries) {
    const childPath = `${parentPath}/${entry.name}`;
    if (mountRoots.has(childPath)) continue;
    if (entry.type === 'directory') {
      let children: DirEntry[];
      try {
        children = await vfs.readDir(childPath);
      } catch (err) {
        if (isAlreadyGone(err)) continue;
        throw err;
      }
      await removeDirectoryEntries(vfs, childPath, children, mountRoots);
      if ([...mountRoots].some((mountRoot) => mountRoot.startsWith(`${childPath}/`))) continue;
    }
    try {
      await vfs.rm(childPath);
    } catch (err) {
      if (!isAlreadyGone(err)) throw err;
    }
  }
}

/** Remove all shared scratch data while leaving `/tmp` ready for the next session. */
export async function resetNewSessionTmp(vfs: NewSessionTmpVfs): Promise<void> {
  const mountRoots = new Set(
    (await vfs.listMountPoints())
      .map(({ path }) => path)
      .filter((path) => path === '/tmp' || path.startsWith('/tmp/'))
  );
  if (mountRoots.has('/tmp')) return;

  let entries: DirEntry[];
  try {
    entries = await vfs.readDir('/tmp');
  } catch (err) {
    if ((err as { code?: string } | null)?.code !== 'ENOENT') throw err;
    await vfs.mkdir('/tmp', { recursive: true });
    return;
  }
  await removeDirectoryEntries(vfs, '/tmp', entries, mountRoots);
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

  const agenticMemorySpawn = apiKey && model ? resolveAgenticMemorySpawn(opts) : undefined;
  if (agenticMemorySpawn) {
    return await runAgenticMemoryFreeze(
      opts,
      sessionStore,
      model!,
      apiKey!,
      headers,
      agenticMemorySpawn
    );
  }

  // 1. WRITE FIRST — durable archive on disk before any LLM call.
  const frozen = await freezeConeSession({
    sessionStore,
    vfs: opts.vfs,
    mode: 'quick',
    cone: opts.cone,
  });
  if (!frozen) return null; // short session / write failure — nothing to do.

  // 1b. Complete-snapshot hook — called after Markdown write succeeds,
  // before the caller clears histories. Failures are caught; the index
  // entry is updated with `completeSnapshotUnavailable: true`.
  // Never writes a raw fallback.
  if (opts.captureCompleteSnapshot) {
    try {
      await opts.captureCompleteSnapshot(frozen);
    } catch (err) {
      const code = (err as { code?: string } | null)?.code ?? 'unknown';
      log.warn('captureCompleteSnapshot failed', { code });
      // Best-effort index update: mark entry so the UI knows the snapshot
      // bundle was not produced. Ignore failures here.
      frozen.completeSnapshotUnavailable = true;
      try {
        await markSnapshotUnavailable(opts.vfs, frozen.filename);
      } catch {
        // Best-effort — the Markdown archive is still present.
      }
    }
  }

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
 * the selected cone's session under a synthetic `pending-…md` filename with the
 * heuristic title. The archive is durable but **never enriched** — the
 * entry stays with its heuristic title and no icon. Designed for the
 * double-click "impatient" gesture where reload latency matters more
 * than archive title fidelity.
 */
export async function runNewSessionFreezeQuick(
  opts: RunNewSessionFreezeOptions
): Promise<FrozenSession | null> {
  return runQuickFreeze(opts, undefined);
}

/**
 * Freeze a cone's chat with NO memory extraction, now or later — the "drop
 * cone" path (#2272). Same durable quick snapshot as the fast new chat, but
 * the archive is marked `memorySkipped` so the catch-up enriches the title
 * and icon only.
 */
export async function runNewSessionArchiveOnly(
  opts: RunNewSessionFreezeOptions
): Promise<FrozenSession | null> {
  return runQuickFreeze(opts, 'skip');
}

async function runQuickFreeze(
  opts: RunNewSessionFreezeOptions,
  memory: 'skip' | undefined
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

  const frozen = await freezeConeSession({
    sessionStore,
    vfs: opts.vfs,
    mode: 'quick',
    cone: opts.cone,
    ...(memory ? { memory } : {}),
  });

  // Complete-snapshot hook — same non-blocking pattern as runNewSessionFreeze.
  // Failures are caught; the index entry is updated with completeSnapshotUnavailable.
  // Never writes a raw fallback.
  if (frozen && opts.captureCompleteSnapshot) {
    try {
      await opts.captureCompleteSnapshot(frozen);
    } catch (err) {
      const code = (err as { code?: string } | null)?.code ?? 'unknown';
      log.warn('captureCompleteSnapshot failed (quick-freeze)', { code });
      frozen.completeSnapshotUnavailable = true;
      try {
        await markSnapshotUnavailable(opts.vfs, frozen.filename);
      } catch {
        // Best-effort — the Markdown archive is still present.
      }
    }
  }

  return frozen;
}
