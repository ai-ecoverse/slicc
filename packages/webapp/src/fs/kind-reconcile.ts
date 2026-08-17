/**
 * `kind-reconcile.ts` — pure decision logic for in-session VFS kind-mismatch
 * recovery (#2006).
 *
 * The in-memory ZenFS index is authoritative at runtime and never re-reads
 * the on-disk sidecar, so an entry whose kind (file vs directory) diverges
 * from OPFS reality poisons every read for the rest of the session:
 * `readFile` on a genuine file throws `EISDIR`, repairs to the on-disk
 * sidecar are invisible until reload, and agents loop on repairs that can
 * never take effect. Production incident 2026-08-08: `/workspace/CLAUDE.md`
 * (a real 16 KB file, clean on disk AND in the sidecar) read as a directory
 * for hours.
 *
 * The decisions live here, pure and unit-testable; `VirtualFS` wires them to
 * the real index, handle cache, and OPFS probe (`makeOpfsProbe`).
 */

import type { SidecarProbeResult } from './sidecar-repair.js';

const S_IFMT = 0o170000;
const S_IFDIR = 0o40000;

/** What the in-memory layer believes a path is. */
export type MemoryKind = 'file' | 'directory' | 'absent';

/** Classify a ZenFS inode `mode` into a {@link MemoryKind}. */
export function memoryKindOfMode(mode: number | undefined): MemoryKind {
  if (mode === undefined) return 'absent';
  return (mode & S_IFMT) === S_IFDIR ? 'directory' : 'file';
}

/**
 * Should the in-memory entry be evicted so the next access re-reads OPFS
 * reality?
 *
 * Heal only when memory HOLDS something and reality disagrees:
 *
 * - memory `directory`, reality `file` (the incident) → heal
 * - memory `file`, reality `directory` → heal
 * - memory holds an entry, reality `missing` → heal (stale entry)
 * - memory agrees with reality → the error was genuine (e.g. actually
 *   reading a directory); do NOT heal, do NOT retry — that would loop.
 * - memory `absent` → nothing to evict; the error came from elsewhere.
 */
export function shouldReconcileKind(truth: SidecarProbeResult, memory: MemoryKind): boolean {
  if (memory === 'absent') return false;
  if (truth.kind === 'missing') return true;
  return truth.kind !== memory;
}

/** One dirty sidecar entry whose kind flipped between memory and disk. */
export interface DirtyKindFlip {
  path: string;
  /** What this realm's in-memory index wants to persist. */
  ownIsDirectory: boolean;
}

/**
 * Read an entry's `mode` from the sidecar's untyped entry value
 * (`Inode.toJSON()` — `sidecar-merge.ts` keeps entries opaque on purpose).
 */
function modeOf(entry: unknown): number | undefined {
  const mode = (entry as { mode?: unknown } | null)?.mode;
  return typeof mode === 'number' ? mode : undefined;
}

/**
 * Find paths the sidecar merge would overlay from the realm's own index whose
 * kind DISAGREES with the on-disk record — the candidates for propagating
 * in-memory corruption onto a correct sidecar (#2006 direction 2). Pure; the
 * caller probes OPFS for each candidate and restores the on-disk record for
 * the ones where memory is the liar (or where reality cannot be verified).
 *
 * Covers BOTH overlay sources of `mergeSidecarEntries`: explicit dirty paths
 * AND every own-index entry under a dirty prefix — a rename's subtree marks
 * overlay entries the paths set never names, so auditing `dirty.paths` alone
 * lets a poisoned descendant bypass the probe entirely.
 *
 * Only paths present on BOTH sides can flip; adds and deletes are not kind
 * conflicts.
 */
export function findDirtyKindFlips(
  own: { entries?: { [path: string]: unknown } },
  onDisk: { entries?: { [path: string]: unknown } },
  dirtyPaths: ReadonlySet<string>,
  dirtyPrefixes: ReadonlySet<string> = new Set()
): DirtyKindFlip[] {
  const candidates = new Set<string>(dirtyPaths);
  if (dirtyPrefixes.size > 0) {
    for (const path of Object.keys(own.entries ?? {})) {
      for (const prefix of dirtyPrefixes) {
        if (path === prefix || path.startsWith(`${prefix}/`)) {
          candidates.add(path);
          break;
        }
      }
    }
  }
  const flips: DirtyKindFlip[] = [];
  for (const path of candidates) {
    const ownEntry = own.entries?.[path];
    const diskEntry = onDisk.entries?.[path];
    if (!ownEntry || !diskEntry) continue;
    const ownKind = memoryKindOfMode(modeOf(ownEntry));
    const diskKind = memoryKindOfMode(modeOf(diskEntry));
    if (ownKind !== diskKind) {
      flips.push({ path, ownIsDirectory: ownKind === 'directory' });
    }
  }
  return flips;
}
