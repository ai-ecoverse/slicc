import {
  SIDECAR_CONSISTENT_ENTRY,
  SIDECAR_SELF_ENTRY,
  type SidecarIndexJson,
} from './sidecar-merge.js';
import {
  certifySidecarConsistency,
  makeBulkOpfsProbe,
  mapPool,
  readOpfsSidecar,
  SIDECAR_REPAIR_CONCURRENCY,
  type SidecarProbe,
  type SidecarProbeResult,
  sidecarConsistencyMatches,
  writeOpfsSidecarText,
} from './sidecar-probe.js';

export type { SidecarProbe, SidecarProbeHint, SidecarProbeResult } from './sidecar-probe.js';
export { makeOpfsProbe, SIDECAR_REPAIR_CONCURRENCY } from './sidecar-probe.js';

const S_IFMT = 0o170000;
const S_IFDIR = 0o40000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

export interface SidecarRepairSummary {
  kindFixed: string[];

  sizesFixed: number;

  dropped: number;

  selfEntryDropped: boolean;

  inosReassigned: number;

  nlinksFixed: number;

  changed: boolean;
}

interface MutableEntry {
  mode?: number;
  size?: number;
  ino?: number;
  data?: number;
  nlink?: number;
}

export async function repairSidecarDocument(
  doc: SidecarIndexJson,
  probe: SidecarProbe,
  onEntry?: () => void,
  concurrency = SIDECAR_REPAIR_CONCURRENCY
): Promise<SidecarRepairSummary> {
  const summary = emptyRepairSummary();
  const entries = doc.entries ?? {};
  const plans: ProbePlan[] = [];
  for (const [path, raw] of Object.entries(entries)) {
    const plan = classifyEntry(path, raw, entries, summary);

    if (!plan) onEntry?.();
    else plans.push(plan);
  }
  const realities = await mapPool(concurrency, plans, async (plan) => {
    onEntry?.();
    const hint = plan.fmt === S_IFDIR ? 'directory' : 'file';
    return probe(plan.path, hint);
  });
  applyProbeResults(plans, realities, entries, summary);
  reassignDuplicateInos(entries, summary);
  return summary;
}

function emptyRepairSummary(): SidecarRepairSummary {
  return {
    kindFixed: [],
    sizesFixed: 0,
    dropped: 0,
    selfEntryDropped: false,
    inosReassigned: 0,
    nlinksFixed: 0,
    changed: false,
  };
}

interface ProbePlan {
  path: string;
  entry: MutableEntry;
  fmt: number;
}

function classifyEntry(
  path: string,
  raw: unknown,
  entries: { [path: string]: unknown },
  summary: SidecarRepairSummary
): ProbePlan | null {
  if (path === '/' || typeof raw !== 'object' || raw === null) return null;

  if (path === SIDECAR_SELF_ENTRY || path === SIDECAR_CONSISTENT_ENTRY) {
    delete entries[path];
    if (path === SIDECAR_SELF_ENTRY) summary.selfEntryDropped = true;
    summary.changed = true;
    return null;
  }
  const entry = raw as MutableEntry;
  const fmt = (entry.mode ?? 0) & S_IFMT;
  if (fmt === S_IFLNK) {
    healNlink(entry, summary);
    return null;
  }
  return { path, entry, fmt };
}

function applyProbeResults(
  plans: readonly ProbePlan[],
  realities: readonly SidecarProbeResult[],
  entries: { [path: string]: unknown },
  summary: SidecarRepairSummary
): void {
  for (let i = 0; i < plans.length; i += 1) {
    const plan = plans[i] as ProbePlan;
    const real = realities[i] as SidecarProbeResult;
    if (real.kind === 'missing') {
      delete entries[plan.path];
      summary.dropped += 1;
      summary.changed = true;
      continue;
    }
    healNlink(plan.entry, summary);
    repairEntryAgainstReality(plan.path, plan.entry, plan.fmt, real, summary);
  }
}

function reassignDuplicateInos(
  entries: { [path: string]: unknown },
  summary: SidecarRepairSummary
): void {
  let ceiling = 0;
  for (const raw of Object.values(entries)) {
    const e = raw as MutableEntry | null;
    if (typeof e?.ino === 'number') ceiling = Math.max(ceiling, e.ino);
    if (typeof e?.data === 'number') ceiling = Math.max(ceiling, e.data);
  }
  let next = ceiling + 1;
  const claimed = new Set<number>();
  for (const [path, raw] of Object.entries(entries)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as MutableEntry;
    if (path === '/') {
      if (typeof entry.ino === 'number') claimed.add(entry.ino);
      continue;
    }
    const ino = entry.ino;
    if (typeof ino === 'number' && ino !== 0 && !claimed.has(ino)) {
      claimed.add(ino);
      continue;
    }
    entry.ino = next;
    entry.data = next + 1;
    claimed.add(next);
    next += 2;
    summary.inosReassigned += 1;
    summary.changed = true;
  }
}

function healNlink(entry: MutableEntry, summary: SidecarRepairSummary): void {
  if (entry.nlink) return;
  entry.nlink = 1;
  summary.nlinksFixed += 1;
  summary.changed = true;
}

function repairEntryAgainstReality(
  path: string,
  entry: MutableEntry,
  fmt: number,
  real: Exclude<SidecarProbeResult, { kind: 'missing' }>,
  summary: SidecarRepairSummary
): void {
  if (fmt === S_IFREG && real.kind === 'directory') {
    entry.mode = ((entry.mode ?? 0) & 0o777 || 0o755) | S_IFDIR;
    summary.kindFixed.push(`${path} file→dir`);
    summary.changed = true;
    return;
  }
  if (fmt === S_IFDIR && real.kind === 'file') {
    entry.mode = ((entry.mode ?? 0) & 0o777 || 0o644) | S_IFREG;

    entry.size = real.size;
    summary.kindFixed.push(`${path} dir→file`);
    summary.changed = true;
    return;
  }
  if (
    fmt === S_IFREG &&
    real.kind === 'file' &&
    typeof entry.size === 'number' &&
    entry.size !== real.size
  ) {
    entry.size = real.size;
    summary.sizesFixed += 1;
    summary.changed = true;
  }
}

export async function resolveWithSidecarRepair<T>(
  resolve: () => Promise<T>,
  repair: () => Promise<SidecarRepairSummary | null>,
  onRepaired: (summary: SidecarRepairSummary) => void
): Promise<T> {
  try {
    return await resolve();
  } catch (err) {
    let summary: SidecarRepairSummary | null = null;
    try {
      summary = await repair();
    } catch {}
    if (!summary?.changed) throw err;
    onRepaired(summary);
    return await resolve();
  }
}

export async function repairOpfsMetadataSidecar(
  handle: FileSystemDirectoryHandle,
  onEntry?: () => void
): Promise<SidecarRepairSummary | null> {
  const loaded = await readOpfsSidecar(handle);
  if (!loaded) return null;
  if (await sidecarConsistencyMatches(handle, loaded.text)) return emptyRepairSummary();
  const summary = await repairSidecarDocument(loaded.doc, makeBulkOpfsProbe(handle), onEntry);
  const next = summary.changed ? JSON.stringify(loaded.doc) : loaded.text;
  if (summary.changed) await writeOpfsSidecarText(handle, next);
  try {
    await certifySidecarConsistency(handle, next);
  } catch {}
  return summary;
}
