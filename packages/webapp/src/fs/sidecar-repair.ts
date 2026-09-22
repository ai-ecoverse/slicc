/**
 * `sidecar-repair.ts` — boot-time validation and self-heal for the OPFS
 * `/.metadata.json` sidecar (#1984).
 *
 * A poisoned sidecar — entries whose recorded kind or size disagrees with
 * the real OPFS tree, or that reference paths no longer on disk — makes
 * `WebAccessFS`'s mount-time `crossCopy` throw (`EISDIR` on a kind flip)
 * and bricks every subsequent boot until the file is fixed by hand. Two
 * production bricks in 12 hours (see #1984, #1992) used exactly the
 * repair implemented here, manually.
 *
 * The pure half (`repairSidecarDocument`) is unit-testable with a fake
 * probe; the thin async half (`repairOpfsMetadataSidecar`) checks the
 * clean-boot mark and, on a miss, probes the real OPFS tree. Directory
 * listings are cached and file sizes are read with bounded concurrency —
 * see `sidecar-probe.ts`. The file is rewritten only when something changed.
 */

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
  /** `path kind→kind` labels for flipped format bits. */
  kindFixed: string[];
  /** Count of file entries whose stale `size` was trued up. */
  sizesFixed: number;
  /** Entries dropped because their path no longer exists. */
  dropped: number;
  /**
   * Whether the self-referential `/.metadata.json` entry was dropped. The
   * sidecar lives inside the mounted directory, so ZenFS indexes it as a file
   * — but its recorded size is stale the instant the sidecar is rewritten (the
   * write changes the very size stored), so a self-entry is a perpetual "file
   * data size mismatch" that re-bricks `crossCopy` on the next mount. Truing
   * the size up cannot converge (each rewrite invalidates it again), so the
   * entry is dropped outright.
   */
  selfEntryDropped: boolean;
  /**
   * Entries whose `ino` was zero/absent or duplicated another entry's and
   * got a fresh unique id (#2146). ZenFS keys its vnode cache by `ino`, so
   * colliding ids collapse unrelated paths onto one shared inode — which
   * then cross-stamps size/mode between them on sync (phantom directories,
   * sibling-size truncation).
   */
  inosReassigned: number;
  /**
   * Entries whose persisted `nlink` was zero/absent and got trued up to 1.
   * ZenFS's `Inode` constructor warns on every `ino != 0 && nlink == 0`
   * inode it materializes, and kerium retains every log entry — a sidecar
   * full of `nlink: 0` entries (the pre-fix #2146 allocations wrote them)
   * flooded the kernel worker's log until its backing Set hit V8's 2^24
   * element cap and every FS op threw (2026-08-18 VFS-offline incident).
   */
  nlinksFixed: number;
  /** Whether anything changed (callers skip the rewrite when false). */
  changed: boolean;
}

interface MutableEntry {
  mode?: number;
  size?: number;
  ino?: number;
  data?: number;
  nlink?: number;
}

/**
 * Validate every entry of `doc` against `probe`, correcting in place:
 *
 * - a `file` entry over a real directory (or vice versa) gets its format
 *   bits flipped, keeping permission bits — the `EISDIR` boot-killer;
 * - a `file` entry whose `size` disagrees with the real file is trued up
 *   (stale sizes surface as ZenFS "file data size mismatch" read errors);
 * - an entry whose path is missing on disk is dropped;
 * - an entry persisted with `nlink: 0` is trued up to 1 (every such entry
 *   makes ZenFS warn on every inode materialization, and kerium's log
 *   retention turned that into the 2026-08-18 Set-overflow VFS outage);
 * - symlink entries otherwise are left alone: their payload lives in a small
 *   real file, and `probe` reporting `file` for them is expected.
 *
 * Mutates and returns `doc`; the summary says what happened.
 *
 * Probes run `concurrency` at a time (default {@link SIDECAR_REPAIR_CONCURRENCY}).
 * Results are applied in sidecar order, so ino reassignment stays deterministic.
 */
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
    // Tick skipped entries here. Probed entries tick inside the pool, as each
    // lookup starts, so a long repair still advances the boot heartbeat.
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

/**
 * Bookkeeping that does not need a disk probe: the root, a non-object, the
 * self-entry, the clean-boot mark, and symlinks. Returns a plan when the
 * entry still has to be checked against OPFS.
 */
function classifyEntry(
  path: string,
  raw: unknown,
  entries: { [path: string]: unknown },
  summary: SidecarRepairSummary
): ProbePlan | null {
  if (path === '/' || typeof raw !== 'object' || raw === null) return null;
  // A sidecar must never track itself: writing it changes its own size, so
  // any recorded `/.metadata.json` size is stale on the retry mount and the
  // boot repair can never converge. Drop it rather than true it up — see
  // {@link SidecarRepairSummary.selfEntryDropped}. The clean-boot mark is
  // the same class of bookkeeping file: persisting it would change the
  // sidecar every time the mark is rewritten.
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

/**
 * Give every entry a UNIQUE `ino` (#2146). The root keeps whatever it has
 * (ZenFS forces `/` to ino 0 on load); any other entry whose ino is
 * zero/absent, or already claimed by an earlier entry, gets a fresh id above
 * the current max of every ino AND data field — mirroring `Index._alloc`'s
 * contract — with `data = ino + 1`. Pure: no I/O, unit-testable.
 *
 * Field data point (2026-08-17, production leader): 2,858 of 14,763 sidecar
 * entries shared ino 0, including both files of the sibling-size incident.
 */
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

/**
 * True up a persisted `nlink: 0` (or absent) to 1. ZenFS's `Inode`
 * constructor logs a warning for every materialized inode with a real ino
 * and no links, so a poisoned sidecar re-arms the warning on every stat of
 * every path — see {@link SidecarRepairSummary.nlinksFixed}. Hardlinks are
 * unsupported on this backend (`IndexFS.link` is ENOSYS), so 1 is always
 * the correct count for a live entry.
 */
function healNlink(entry: MutableEntry, summary: SidecarRepairSummary): void {
  if (entry.nlink) return;
  entry.nlink = 1;
  summary.nlinksFixed += 1;
  summary.changed = true;
}

/** Correct one present-on-disk entry's format bits or size in place. */
function repairEntryAgainstReality(
  path: string,
  entry: MutableEntry,
  fmt: number,
  real: Exclude<SidecarProbeResult, { kind: 'missing' }>,
  summary: SidecarRepairSummary
): void {
  // Preserve permission bits on kind flips; default them only when absent.
  if (fmt === S_IFREG && real.kind === 'directory') {
    entry.mode = ((entry.mode ?? 0) & 0o777 || 0o755) | S_IFDIR;
    summary.kindFixed.push(`${path} file→dir`);
    summary.changed = true;
    return;
  }
  if (fmt === S_IFDIR && real.kind === 'file') {
    entry.mode = ((entry.mode ?? 0) & 0o777 || 0o644) | S_IFREG;
    // A directory entry carries no size; the flipped file entry must state
    // the real one or the retry mount re-enters the size-mismatch storm.
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

/**
 * Boot-time self-heal: run `resolve` (the ZenFS mount, whose `crossCopy`
 * trusts the sidecar); on failure, `repair` the sidecar and retry ONCE.
 * The original error is rethrown when the repair found nothing to fix —
 * the failure then has a different cause and a blind retry would only
 * mask it. Control flow only, so the brick→repair→boot path is testable
 * without OPFS.
 */
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
    } catch {
      /* repair is best-effort — fall through to the original error */
    }
    if (!summary?.changed) throw err;
    onRepaired(summary);
    return await resolve();
  }
}

/**
 * Read, repair, and (when anything changed) rewrite `/.metadata.json`
 * under `handle`. Returns the repair summary, or `null` when there is no
 * parseable sidecar to repair (absent or corrupt JSON — ZenFS reseeds an
 * absent sidecar itself, and `initOpfsBackend` seeds an empty one).
 *
 * A sidecar whose bytes still match the clean-boot mark is returned
 * unchanged and is not probed. The mark is written only after a probe, and
 * deleted before the next mutation, so a crash mid-write cannot skip a
 * tree the sidecar no longer describes.
 */
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
  } catch {
    // The sidecar is already consistent. A missed mark only costs the next
    // boot a re-probe; it must not fail the mount.
  }
  return summary;
}
