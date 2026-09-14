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

const FREEZER_SESSION_ANCHOR = 'ui-new-session';

const DEFAULT_ENRICHMENT_RACE_MS = 20_000;

const ENRICHMENT_PROGRESS_TICK_MS = 250;

export interface PendingSessionCatchupOptions {
  openVfs: () => Promise<WritableVfsClient>;
  onComplete?: () => void;
  schedule?: (callback: () => void) => void;
}

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
      } catch {}
    }
  }
  void runAgenticBackgroundPass(opts, sessionStore, model, apiKey, headers, spawn, frozen);
  return frozen;
}

async function runAgenticBackgroundPass(
  opts: RunNewSessionFreezeOptions,
  sessionStore: SessionStore,
  model: Model<Api>,
  apiKey: string,
  headers: Record<string, string> | undefined,
  spawn: AgentBridge['spawn'],
  frozen: FrozenSession
): Promise<void> {
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
  opts.onSessionSettled?.(curated ?? current);
}

export interface RunNewSessionFreezeOptions {
  vfs: WritableVfsClient;

  agenticMemorySpawn?: AgentBridge['spawn'];

  enrichmentRaceMs?: number;

  onProgress?: (fraction: number | null) => void;

  onBackgroundEnriched?: (entry: FrozenSessionIndexEntry | null) => void;

  onSessionSettled?: (entry: FrozenSessionIndexEntry | null) => void;

  captureCompleteSnapshot?: (frozen: FrozenSession) => Promise<void>;

  cone?: FreezerConeRef;
}

type NewSessionTmpVfs = Pick<WritableVfsClient, 'listMountPoints' | 'mkdir' | 'readDir' | 'rm'>;

function isAlreadyGone(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'ENOENT';
}

function containsPath(ancestor: string, path: string): boolean {
  if (ancestor === path) return true;
  return path.startsWith(ancestor.endsWith('/') ? ancestor : `${ancestor}/`);
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

export async function resetNewSessionTmp(vfs: NewSessionTmpVfs, tmpDir: string): Promise<void> {
  const mounts = (await vfs.listMountPoints()).map(({ path }) => path);
  if (mounts.some((mount) => containsPath(mount, tmpDir))) return;
  const mountRoots = new Set(mounts.filter((path) => path.startsWith(`${tmpDir}/`)));

  let entries: DirEntry[];
  try {
    entries = await vfs.readDir(tmpDir);
  } catch (err) {
    if ((err as { code?: string } | null)?.code !== 'ENOENT') throw err;
    await vfs.mkdir(tmpDir, { recursive: true });
    return;
  }
  await removeDirectoryEntries(vfs, tmpDir, entries, mountRoots);
  await vfs.mkdir(tmpDir, { recursive: true });
}

type EnrichmentRaceResult =
  | { kind: 'llm'; updated: FrozenSessionIndexEntry | null }
  | { kind: 'timer' };

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

  const frozen = await freezeConeSession({
    sessionStore,
    vfs: opts.vfs,
    mode: 'quick',
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
      } catch {}
    }
  }

  if (!apiKey || !model) {
    log.info('Frozen without enrichment (no LLM credentials) — left pending', {
      filename: frozen.filename,
    });
    opts.onSessionSettled?.(frozen);
    return frozen;
  }

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

  const winner = await raceEnrichmentAgainstTimer(enrichment, raceMs, opts.onProgress);

  if (winner.kind === 'llm') {
    const settled = winner.updated ? { ...winner.updated, archive: frozen.archive } : frozen;
    opts.onSessionSettled?.(settled);
    return settled;
  }

  void enrichment.then((updated) => {
    log.info('Background enrichment resolved after race window', {
      filename: frozen.filename,
      enriched: updated?.filename ?? null,
    });
    opts.onBackgroundEnriched?.(updated);
    opts.onSessionSettled?.(updated ?? frozen);
  });
  return frozen;
}

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

export async function runNewSessionFreezeQuick(
  opts: RunNewSessionFreezeOptions
): Promise<FrozenSession | null> {
  return runQuickFreeze(opts, undefined);
}

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

  if (frozen && opts.captureCompleteSnapshot) {
    try {
      await opts.captureCompleteSnapshot(frozen);
    } catch (err) {
      const code = (err as { code?: string } | null)?.code ?? 'unknown';
      log.warn('captureCompleteSnapshot failed (quick-freeze)', { code });
      frozen.completeSnapshotUnavailable = true;
      try {
        await markSnapshotUnavailable(opts.vfs, frozen.filename);
      } catch {}
    }
  }

  if (frozen) opts.onSessionSettled?.(frozen);
  return frozen;
}
