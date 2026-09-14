import type { Registry } from '../registry.js';
import type { SandboxSubstrate } from '../substrate.js';
import type { ConeEntry, SandboxSummary } from '../types.js';

export interface ListConesDeps {
  substrate: SandboxSubstrate;
  registry: Registry;
}

export interface ListConesOpts {
  metadata?: Record<string, string>;
}

const STALE_RESERVATION_MS = 10 * 60 * 1000;
const DEFAULT_TTL_MS = 60 * 60 * 1000;

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
  if (!entry.reservedAt) return true;
  return Date.now() - new Date(entry.reservedAt).getTime() > STALE_RESERVATION_MS;
}

async function reconcileReserved(entry: ConeEntry, registry: Registry): Promise<ConeEntry | null> {
  if (!isStaleReservation(entry)) return entry;

  await registry.remove(entry.sandboxId);
  console.warn('[cloud-core] reclaimed stale reservation', {
    sandboxId: entry.sandboxId,
    reservedAt: entry.reservedAt ?? '(missing)',
  });
  return null;
}

async function markDead(entry: ConeEntry, registry: Registry): Promise<ConeEntry> {
  if (entry.state !== 'dead') {
    await registry.update(entry.sandboxId, { state: 'dead' });
  }
  return { ...entry, state: 'dead' };
}

async function reconcileLiveEntry(
  entry: ConeEntry,
  liveById: Map<string, SandboxSummary>,
  registry: Registry
): Promise<ConeEntry> {
  const liveEntry = liveById.get(entry.sandboxId);
  if (!liveEntry) {
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
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[cloud-core] orphan recovery readFile failed', {
      sandboxId: summary.sandboxId,
      err: msg,
    });
    return seed;
  }
}

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
          const msg = err instanceof Error ? err.message : String(err);
          console.warn('[cloud-core] extendTimeout failed', { sandboxId: c.sandboxId, err: msg });
        }
      })
  );
}

export async function listCones(
  deps: ListConesDeps,
  opts: ListConesOpts = {}
): Promise<ConeEntry[]> {
  const registryEntries = await deps.registry.list();

  const live = await deps.substrate.list(opts.metadata ? { metadata: opts.metadata } : undefined);
  const liveById = new Map(live.map((s) => [s.sandboxId, s] as const));

  const reconciled: ConeEntry[] = [];
  for (const entry of registryEntries) {
    const next = await reconcileRegistryEntry(entry, liveById, deps.registry);
    if (next) reconciled.push(next);
  }

  for (const summary of liveById.values()) {
    const recovered = await recoverOrphan(summary, deps.substrate);
    await deps.registry.append(recovered);
    reconciled.push(recovered);
  }

  await extendRunningTimeouts(reconciled, deps.substrate);

  return reconciled.filter((e) => matchesMetadataFilter(e, opts.metadata));
}
