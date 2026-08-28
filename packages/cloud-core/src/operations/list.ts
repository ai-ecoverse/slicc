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

const STALE_RESERVATION_MS = 10 * 60 * 1000;
const DEFAULT_TTL_MS = 60 * 60 * 1000;

/** True when entry metadata matches every key/value in the filter (or no filter). */
function matchesMetadataFilter(
  entry: ConeEntry,
  metadata: Record<string, string> | undefined
): boolean {
  if (!metadata) return true;
  if (!entry.metadata) return false;
  for (const [k, v] of Object.entries(metadata)) {
    if (entry.metadata[k] !== v) return false;
  }
  return true;
}

function isStaleReservation(entry: ConeEntry): boolean {
  // Reclaim if stale OR if reservedAt is missing (legacy/malformed entry
  // from before commit e9011ba6 — could otherwise wedge cap forever).
  if (!entry.reservedAt) return true;
  return Date.now() - new Date(entry.reservedAt).getTime() > STALE_RESERVATION_MS;
}

/**
 * Handle a reserved registry entry: reclaim if stale, otherwise keep.
 * Returns the entry to include in the reconciled list, or null if reclaimed.
 */
async function reconcileReserved(entry: ConeEntry, registry: Registry): Promise<ConeEntry | null> {
  if (!isStaleReservation(entry)) return entry;

  await registry.remove(entry.sandboxId);
  console.warn('[cloud-core] reclaimed stale reservation', {
    sandboxId: entry.sandboxId,
    reservedAt: entry.reservedAt ?? '(missing)',
  });
  return null;
}

/** Mark a missing real sandbox dead (idempotent registry write). */
async function markDead(entry: ConeEntry, registry: Registry): Promise<ConeEntry> {
  if (entry.state !== 'dead') {
    await registry.update(entry.sandboxId, { state: 'dead' });
  }
  return { ...entry, state: 'dead' };
}

/**
 * Reconcile one non-reserved registry entry against live substrate state.
 * Mutates liveById (deletes matched sandbox ids).
 */
async function reconcileLiveEntry(
  entry: ConeEntry,
  liveById: Map<string, SandboxSummary>,
  registry: Registry
): Promise<ConeEntry> {
  const liveEntry = liveById.get(entry.sandboxId);
  if (!liveEntry) {
    // Substrate doesn't know about it — mark dead unless it's a placeholder.
    // The 'pending-' prefix is a sentinel for "no real sandbox yet" (paired
    // with state:'reserved' by reserveSlot before substrate.create).
    if (entry.sandboxId.startsWith('pending-')) {
      return entry;
    }
    return markDead(entry, registry);
  }

  if (entry.state !== liveEntry.state) {
    await registry.update(entry.sandboxId, { state: liveEntry.state });
  }
  liveById.delete(entry.sandboxId);
  return { ...entry, state: liveEntry.state };
}

async function reconcileRegistryEntry(
  entry: ConeEntry,
  liveById: Map<string, SandboxSummary>,
  registry: Registry
): Promise<ConeEntry | null> {
  // Reserved entries: check for stale reservations (TTL: 10 min) and reclaim.
  // Stale reservations are from crashed operations that never completed or rolled back.
  if (entry.state === 'reserved') {
    return reconcileReserved(entry, registry);
  }
  return reconcileLiveEntry(entry, liveById, registry);
}

interface JoinRecovery {
  joinUrl: string;
  trayId: string | undefined;
  lastJoinUpdatedAt: string | undefined;
}

/**
 * Recover joinUrl from /tmp/slicc-join.json ONLY when sandbox is running.
 * Calling substrate.connect() on a paused sandbox would RESUME it, which:
 * (a) burns sandbox runtime silently
 * (b) destabilizes the leader chromium mid-list
 * Paused orphans surface with joinUrl='' — UI hides the Open button.
 */
async function recoverJoinFromSandbox(
  summary: SandboxSummary,
  substrate: SandboxSubstrate,
  seed: JoinRecovery
): Promise<JoinRecovery> {
  if (seed.joinUrl || summary.state !== 'running') return seed;

  try {
    const handle = await substrate.connect(summary.sandboxId);
    const joinData = await handle.readFile('/tmp/slicc-join.json');
    const parsed = JSON.parse(joinData) as {
      joinUrl?: string;
      trayId?: string;
      updatedAt?: string;
    };
    return {
      joinUrl: parsed.joinUrl ?? '',
      trayId: seed.trayId ?? parsed.trayId,
      lastJoinUpdatedAt: seed.lastJoinUpdatedAt ?? parsed.updatedAt,
    };
  } catch (err) {
    // File not readable (sandbox is transitioning, or file doesn't exist).
    // Leave joinUrl empty — UI will handle gracefully.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[cloud-core] orphan recovery readFile failed', {
      sandboxId: summary.sandboxId,
      err: msg,
    });
    return seed;
  }
}

/** Rebuild a ConeEntry for a substrate sandbox missing from the registry. */
async function recoverOrphan(
  summary: SandboxSummary,
  substrate: SandboxSubstrate
): Promise<ConeEntry> {
  const now = new Date().toISOString();
  const recoveredJoin = await recoverJoinFromSandbox(summary, substrate, {
    joinUrl: summary.metadata?.['joinUrl'] ?? '',
    trayId: summary.metadata?.['trayId'],
    lastJoinUpdatedAt: summary.metadata?.['lastJoinUpdatedAt'],
  });

  return {
    sandboxId: summary.sandboxId,
    substrate: 'e2b',
    name: summary.metadata?.['name'] ?? summary.name,
    createdAt: summary.metadata?.['createdAt'] ?? now,
    joinUrl: recoveredJoin.joinUrl,
    lastSeen: now,
    state: summary.state,
    trayId: recoveredJoin.trayId,
    lastJoinUpdatedAt: recoveredJoin.lastJoinUpdatedAt,
    metadata: summary.metadata,
  };
}

/**
 * Refresh the timeout of every running cone so active users keep their cones
 * alive past the 1h default. Failures are non-fatal — a sandbox that
 * disappears between substrate.list() and extendTimeout() will be discovered
 * dead on the NEXT list call.
 */
async function extendRunningTimeouts(
  cones: ConeEntry[],
  substrate: SandboxSubstrate
): Promise<void> {
  await Promise.all(
    cones
      .filter((c) => c.state === 'running')
      .map(async (c) => {
        try {
          await substrate.extendTimeout(c.sandboxId, DEFAULT_TTL_MS);
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

  // Pass 1: walk registry; reconcile against live.
  // Reconciliation runs for EVERY registry entry regardless of metadata filter
  // — otherwise zombie entries (e.g. legacy entries without userId metadata)
  // never get marked dead and accumulate forever in cap math. The metadata
  // filter is applied to the RETURN value only, so callers still see their
  // per-user view.
  const reconciled: ConeEntry[] = [];
  for (const entry of registryEntries) {
    const next = await reconcileRegistryEntry(entry, liveById, deps.registry);
    if (next) reconciled.push(next);
  }

  // Pass 2: any substrate entries not in registry → recover.
  for (const summary of liveById.values()) {
    const recovered = await recoverOrphan(summary, deps.substrate);
    await deps.registry.append(recovered);
    reconciled.push(recovered);
  }

  await extendRunningTimeouts(reconciled, deps.substrate);

  // Apply the metadata filter to the RETURN value only — reconciliation
  // above ran on all entries to keep zombies from accumulating.
  return reconciled.filter((e) => matchesMetadataFilter(e, opts.metadata));
}
