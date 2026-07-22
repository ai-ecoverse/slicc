import type { Registry } from '../registry.js';
import type { SandboxSubstrate } from '../substrate.js';
import type { ConeEntry, SandboxSummary } from '../types.js';

export interface ListConesDeps {
  substrate: SandboxSubstrate;
  registry: Registry;
}

export interface ListConesOpts {
  /**
   * Restrict substrate.list to sandboxes whose metadata matches.
   * Worker passes { userId } to scope per-user. CLI passes nothing
   * (sees every sandbox in the team account).
   */
  metadata?: Record<string, string>;
}

// Reconcile a single registry entry against the live substrate view.
// Returns the reconciled entry, or null when a stale reservation was
// reclaimed (i.e. the entry should be dropped, not kept).
//
// Reserved entries: check for stale reservations (TTL: 10 min) and reclaim.
// Stale reservations are from crashed operations that never completed or
// rolled back.
async function reconcileRegistryEntry(
  deps: ListConesDeps,
  entry: ConeEntry,
  liveById: Map<string, SandboxSummary>
): Promise<ConeEntry | null> {
  if (entry.state === 'reserved') {
    const STALE_MS = 10 * 60 * 1000;
    // Reclaim if stale OR if reservedAt is missing (legacy/malformed entry
    // from before commit e9011ba6 — could otherwise wedge in-flight
    // start/resume coordination forever).
    const isStale =
      !entry.reservedAt || Date.now() - new Date(entry.reservedAt).getTime() > STALE_MS;
    if (isStale) {
      await deps.registry.remove(entry.sandboxId);
      console.warn('[cloud-core] reclaimed stale reservation', {
        sandboxId: entry.sandboxId,
        reservedAt: entry.reservedAt ?? '(missing)',
      });
      return null;
    }
    // Active reservation — preserve as-is while start/resume coordination is
    // in flight. The reserved registry state remains authoritative for both a
    // start's synthetic 'pending-' ID and a resume's real sandbox ID. Delete any
    // matching live entry so pass 2's orphan recovery cannot overwrite the
    // reservation with the substrate's raw state before coordination completes.
    liveById.delete(entry.sandboxId);
    return entry;
  }

  const liveEntry = liveById.get(entry.sandboxId);
  if (!liveEntry) {
    // Substrate doesn't know about it — mark dead unless it's a placeholder.
    // The 'pending-' prefix is a sentinel for "no real sandbox yet" (paired
    // with state:'reserved' by reserveConeStart before substrate.create).
    if (entry.sandboxId.startsWith('pending-')) {
      // Reservation placeholder — no real sandbox yet. Keep it alive.
      return entry;
    }
    // Real sandbox is missing — mark dead
    if (entry.state !== 'dead') {
      await deps.registry.update(entry.sandboxId, { state: 'dead' });
    }
    return { ...entry, state: 'dead' };
  }

  if (entry.state !== liveEntry.state) {
    await deps.registry.update(entry.sandboxId, { state: liveEntry.state });
  }
  liveById.delete(entry.sandboxId);
  return { ...entry, state: liveEntry.state };
}

// Rebuild a registry entry for a substrate sandbox that has no registry
// record (orphan recovery), reading its real joinUrl off disk when possible.
async function recoverOrphanCone(deps: ListConesDeps, summary: SandboxSummary): Promise<ConeEntry> {
  const now = new Date().toISOString();

  // Try to read the real joinUrl from the sandbox. Orphans created before this
  // fix won't have it in metadata, but we can read /tmp/slicc-join.json directly.
  let joinUrl = summary.metadata?.['joinUrl'] ?? '';
  let trayId = summary.metadata?.['trayId'];
  let lastJoinUpdatedAt = summary.metadata?.['lastJoinUpdatedAt'];

  // Recover joinUrl from /tmp/slicc-join.json ONLY when sandbox is running.
  // Calling substrate.connect() on a paused sandbox would RESUME it, which:
  // (a) burns sandbox runtime silently
  // (b) destabilizes the leader chromium mid-list
  // Paused orphans surface with joinUrl='' — UI hides the Open button.
  // User explicitly resumes via /api/cloud/resume which writes a fresh joinUrl.
  if (!joinUrl && summary.state === 'running') {
    try {
      const handle = await deps.substrate.connect(summary.sandboxId);
      const joinData = await handle.readFile('/tmp/slicc-join.json');
      const parsed = JSON.parse(joinData);
      joinUrl = parsed.joinUrl ?? '';
      trayId = trayId ?? parsed.trayId;
      lastJoinUpdatedAt = lastJoinUpdatedAt ?? parsed.updatedAt;
    } catch (err) {
      // File not readable (sandbox is transitioning, or file doesn't exist).
      // Leave joinUrl empty — UI will handle gracefully.
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[cloud-core] orphan recovery readFile failed', {
        sandboxId: summary.sandboxId,
        err: msg,
      });
    }
  }

  const recovered: ConeEntry = {
    sandboxId: summary.sandboxId,
    substrate: 'e2b',
    name: summary.metadata?.['name'] ?? summary.name,
    createdAt: summary.metadata?.['createdAt'] ?? now,
    joinUrl,
    lastSeen: now,
    state: summary.state,
    trayId,
    lastJoinUpdatedAt,
    metadata: summary.metadata,
  };
  await deps.registry.append(recovered);
  return recovered;
}

// Refresh the timeout of every running cone so active users keep their cones
// alive past the 1h default. Failures are non-fatal — a sandbox that
// disappears between substrate.list() and extendTimeout() will be discovered
// dead on the NEXT list call.
async function refreshRunningTimeouts(deps: ListConesDeps, reconciled: ConeEntry[]): Promise<void> {
  const DEFAULT_TTL_MS = 60 * 60 * 1000;
  await Promise.all(
    reconciled
      .filter((c) => c.state === 'running')
      .map(async (c) => {
        try {
          await deps.substrate.extendTimeout(c.sandboxId, DEFAULT_TTL_MS);
        } catch (err) {
          // Sandbox may have died between list and extendTimeout; ignore.
          const msg = err instanceof Error ? err.message : String(err);
          console.warn('[cloud-core] extendTimeout failed', { sandboxId: c.sandboxId, err: msg });
        }
      })
  );
}

/**
 * List cones reconciling registry against substrate.
 * - Substrate is source of truth for state (running/paused).
 * - Registry entries missing from substrate → marked 'dead'.
 * - Substrate sandboxes not in registry → rebuilt and appended (orphan recovery).
 *
 * Reconciliation writes are persisted to registry (state flips, entry adds).
 */
export async function listCones(
  deps: ListConesDeps,
  opts: ListConesOpts = {}
): Promise<ConeEntry[]> {
  const registryEntries = await deps.registry.list();
  // Pass metadata filter to substrate.list for server-side filtering
  const live = await deps.substrate.list(opts.metadata ? { metadata: opts.metadata } : undefined);
  const liveById = new Map(live.map((s) => [s.sandboxId, s] as const));

  // Helper to check if an entry matches the metadata filter
  const matchesFilter = (entry: ConeEntry): boolean => {
    if (!opts.metadata) return true;
    if (!entry.metadata) return false;
    for (const [k, v] of Object.entries(opts.metadata)) {
      if (entry.metadata[k] !== v) return false;
    }
    return true;
  };

  // Pass 1: walk registry; reconcile against live.
  // Reconciliation runs for EVERY registry entry regardless of metadata filter
  // — otherwise zombie entries (e.g. legacy entries without userId metadata)
  // never get marked dead and accumulate forever in the registry. The metadata
  // filter is applied to the RETURN value only, so callers still see their
  // per-user view.
  const reconciled: ConeEntry[] = [];
  for (const entry of registryEntries) {
    const result = await reconcileRegistryEntry(deps, entry, liveById);
    if (result) reconciled.push(result);
  }

  // Pass 2: any substrate entries not in registry → recover.
  for (const summary of liveById.values()) {
    reconciled.push(await recoverOrphanCone(deps, summary));
  }

  await refreshRunningTimeouts(deps, reconciled);

  // Apply the metadata filter to the RETURN value only — reconciliation
  // above ran on all entries to keep zombies from accumulating in the registry.
  return reconciled.filter(matchesFilter);
}
