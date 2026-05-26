import type { Registry } from '../registry.js';
import type { SandboxSubstrate } from '../substrate.js';
import type { ConeEntry } from '../types.js';

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
  const live = await deps.substrate.list();

  // The current substrate.list() signature is parameterless (no ListOpts param yet).
  // Plan D Task D7+D10 will add it. For now, we still accept opts.metadata in this
  // function signature so callers can pass it (forward-compat), but we won't filter
  // by metadata at the substrate level — the e2b adapter sees all sandboxes in the
  // team account either way. We can optionally filter the returned list locally:
  const filtered = opts.metadata
    ? live.filter((s) => {
        if (!s.metadata) return false;
        for (const [k, v] of Object.entries(opts.metadata!)) {
          if (s.metadata[k] !== v) return false;
        }
        return true;
      })
    : live;
  const liveById = new Map(filtered.map((s) => [s.sandboxId, s] as const));

  // Pass 1: walk registry; reconcile against live.
  const reconciled: ConeEntry[] = [];
  for (const entry of registryEntries) {
    const liveEntry = liveById.get(entry.sandboxId);
    if (!liveEntry) {
      // Substrate doesn't know about it — sandbox expired or was killed externally.
      if (entry.state !== 'dead') {
        await deps.registry.update(entry.sandboxId, { state: 'dead' });
      }
      reconciled.push({ ...entry, state: 'dead' });
      continue;
    }
    if (entry.state !== liveEntry.state) {
      await deps.registry.update(entry.sandboxId, { state: liveEntry.state });
    }
    reconciled.push({ ...entry, state: liveEntry.state });
    liveById.delete(entry.sandboxId);
  }

  // Pass 2: any substrate entries not in registry → recover.
  for (const summary of liveById.values()) {
    const now = new Date().toISOString();
    const recovered: ConeEntry = {
      sandboxId: summary.sandboxId,
      substrate: 'e2b',
      name: summary.metadata?.['name'] ?? summary.name,
      createdAt: summary.metadata?.['createdAt'] ?? now,
      joinUrl: summary.metadata?.['joinUrl'] ?? `https://w/join/${summary.sandboxId}`,
      lastSeen: now,
      state: summary.state,
      trayId: summary.metadata?.['trayId'],
      lastJoinUpdatedAt: summary.metadata?.['lastJoinUpdatedAt'],
    };
    await deps.registry.append(recovered);
    reconciled.push(recovered);
  }
  return reconciled;
}
