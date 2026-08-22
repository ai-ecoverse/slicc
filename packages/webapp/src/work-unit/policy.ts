/**
 * Policy presets and derivation for work units (#1666).
 *
 * Presets are convenience configuration, not runtime types. Phase 1 derives
 * the policy from the existing record shape so behaviour is unchanged; in
 * Phase 3 the runtime reads `policy.*` instead of `isCone` and these become
 * the source of truth.
 */

import type { RegisteredScoop } from '../scoops/types.js';
import type { CompletionPolicy, WorkUnitId, WorkUnitPolicy } from './types.js';

/** `true` when the record is a root unit (a cone). The ONLY root test. */
export function isRootUnit(scoop: Pick<RegisteredScoop, 'parentJid'>): boolean {
  return scoop.parentJid === null;
}

/** Interactive root preset — what the cone gets today. */
export function interactiveRootPolicy(): WorkUnitPolicy {
  return {
    filesystem: { kind: 'full-workspace' },
    canCreateChildren: true,
    canManageChildren: true,
    canWriteSharedMemory: true,
    canResolveApprovals: true,
    approvalAuthority: 'user',
    sudoDefaultDisposition: 'allow',
    persistCommandGrants: true,
  };
}

/**
 * Delegated child preset — what a scoop gets today. The path lists are a
 * pure copy of `ScoopConfig` (defaults live in `scoop_scoop` and the restore
 * backfill, not here).
 */
export function delegatedChildPolicy(
  parentId: WorkUnitId,
  paths: { writablePaths?: readonly string[]; visiblePaths?: readonly string[] } = {}
): WorkUnitPolicy {
  return {
    filesystem: {
      kind: 'restricted',
      writablePaths: [...(paths.writablePaths ?? [])],
      visiblePaths: [...(paths.visiblePaths ?? [])],
    },
    canCreateChildren: false,
    canManageChildren: false,
    canWriteSharedMemory: false,
    canResolveApprovals: false,
    approvalAuthority: { parentId },
    sudoDefaultDisposition: 'require-approval',
    persistCommandGrants: false,
  };
}

/** Derive the policy of a registered record from its ownership edge. */
export function derivePolicy(scoop: RegisteredScoop): WorkUnitPolicy {
  if (scoop.parentJid === null) return interactiveRootPolicy();
  return delegatedChildPolicy(scoop.parentJid, {
    writablePaths: scoop.config?.writablePaths,
    visiblePaths: scoop.config?.visiblePaths,
  });
}

/** Derive the completion policy of a registered record. */
export function deriveCompletion(scoop: RegisteredScoop): CompletionPolicy {
  if (scoop.parentJid === null) return { mode: 'interactive' };
  if (scoop.notifyOnComplete === false) return { mode: 'silent' };
  return { mode: 'notify-parent' };
}

const CAPABILITY_FLAGS = [
  'canCreateChildren',
  'canManageChildren',
  'canWriteSharedMemory',
  'canResolveApprovals',
  'persistCommandGrants',
] as const;

/**
 * Invariant: `child capabilities ⊆ parent capabilities`. A child may never
 * hold a boolean capability its parent lacks, may not auto-allow sudo when
 * its parent must ask, and may not see the full workspace when its parent
 * is restricted.
 */
export function isPolicySubset(child: WorkUnitPolicy, parent: WorkUnitPolicy): boolean {
  for (const flag of CAPABILITY_FLAGS) {
    if (child[flag] && !parent[flag]) return false;
  }
  if (child.sudoDefaultDisposition === 'allow' && parent.sudoDefaultDisposition !== 'allow') {
    return false;
  }
  if (child.filesystem.kind === 'full-workspace' && parent.filesystem.kind !== 'full-workspace') {
    return false;
  }
  return true;
}

/** Records owned directly by `id` (not transitive). */
export function childrenOf<T extends Pick<RegisteredScoop, 'parentJid'>>(
  scoops: Iterable<T>,
  id: WorkUnitId
): T[] {
  const out: T[] = [];
  for (const scoop of scoops) if (scoop.parentJid === id) out.push(scoop);
  return out;
}

/**
 * The root that owns `unit` — the unit itself when it is one. Walks the
 * `parentJid` chain; returns `undefined` when the chain dangles (a parent that
 * is no longer registered) or loops, so callers can fall back deliberately
 * instead of treating a child as an owner.
 */
export function rootOwnerOf<T extends Pick<RegisteredScoop, 'jid' | 'parentJid'>>(
  units: Iterable<T>,
  unit: T | undefined
): T | undefined {
  if (!unit) return undefined;
  const byJid = new Map<string, T>();
  for (const u of units) byJid.set(u.jid, u);
  const seen = new Set<string>();
  let current: T | undefined = unit;
  while (current && current.parentJid !== null && !seen.has(current.jid)) {
    seen.add(current.jid);
    current = byJid.get(current.parentJid);
  }
  return current?.parentJid === null ? current : undefined;
}

/** Root records, oldest first (`addedAt` ascending, then jid for stability). */
export function rootsOf<T extends Pick<RegisteredScoop, 'parentJid' | 'addedAt' | 'jid'>>(
  scoops: Iterable<T>
): T[] {
  const out: T[] = [];
  for (const scoop of scoops) if (scoop.parentJid === null) out.push(scoop);
  return out.sort((a, b) => a.addedAt.localeCompare(b.addedAt) || a.jid.localeCompare(b.jid));
}
