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
  const reconciled: ConeEntry[] = [];
  for (const entry of registryEntries) {
    // Skip entries that don't match the metadata filter
    if (!matchesFilter(entry)) continue;

    const liveEntry = liveById.get(entry.sandboxId);
    if (!liveEntry) {
      // Substrate doesn't know about it. Two cases:
      // 1. Reservation placeholders (sandboxId starts with 'pending-'): keep as running
      // 2. Real sandboxes that expired or were killed externally: mark dead
      if (entry.sandboxId.startsWith('pending-')) {
        // Reservation placeholder — keep it alive
        reconciled.push(entry);
      } else {
        // Real sandbox is missing — mark dead
        if (entry.state !== 'dead') {
          await deps.registry.update(entry.sandboxId, { state: 'dead' });
        }
        reconciled.push({ ...entry, state: 'dead' });
      }
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
    };
    await deps.registry.append(recovered);
    reconciled.push(recovered);
  }

  // Refresh the timeout of every running cone so active users keep their cones
  // alive past the 1h default. Failures are non-fatal — a sandbox that
  // disappears between substrate.list() and extendTimeout() will be discovered
  // dead on the NEXT list call.
  const DEFAULT_TTL_MS = 60 * 60 * 1000;
  await Promise.all(
    reconciled
      .filter((c) => c.state === 'running')
      .map(async (c) => {
        try {
          await deps.substrate.extendTimeout(c.sandboxId, DEFAULT_TTL_MS);
        } catch {
          // Sandbox may have died between list and extendTimeout; ignore.
        }
      })
  );

  return reconciled;
}
