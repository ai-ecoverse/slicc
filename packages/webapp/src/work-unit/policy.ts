/**
 * Policy presets and derivation for work units (#1666).
 *
 * Presets are convenience configuration, not runtime types. Phase 1 derives
 * the policy from the existing record shape so behaviour is unchanged; in
 * Phase 3 the runtime reads `policy.*` instead of `isCone` and these become
 * the source of truth.
 */

import { normalizePath } from '../fs/path-utils.js';
import type { RegisteredScoop } from '../scoops/types.js';
import type {
  CompletionPolicy,
  FileSystemPolicy,
  WorkspaceIsolationMode,
  WorkUnitId,
  WorkUnitPolicy,
} from './types.js';
import {
  DEFAULT_CHILD_WORKSPACE_MODE,
  parseWorkspaceMode,
  workspaceModeRank,
} from './workspace-mode.js';

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
  paths: {
    writablePaths?: readonly string[];
    visiblePaths?: readonly string[];
    /**
    /**
     * Sharing policy (#2277). Default `shared-readonly` is today's scoop.
     * Unimplemented modes are still recorded on the policy so a restore of a
     * future record does not silently downgrade; construction throws before
     * a RestrictedFS is built.
     */
    mode?: WorkspaceIsolationMode;
    /**
     * Shell allow-list. Omitted → unrestricted (same as ScoopConfig).
     */
    allowedCommands?: readonly string[];
    /**
     * Grant the approval-settling capability — the `scoop` approver tier. Only
     * ever true for a record explicitly marked `approvesGuestRequests`, and the
     * parent (a root) already holds it, so the subset invariant is preserved.
     */
    approvesGuestRequests?: boolean;
    /**
     * Nested-delegation grant. Only ever true for a record whose config
     * explicitly sets `canCreateChildren`, and the parent must already hold
     * the flag (`assertChildPolicyAllowed` / `isPolicySubset`).
     */
    canCreateChildren?: boolean;
  } = {}
): WorkUnitPolicy {
  const nested = paths.canCreateChildren === true;
  return {
    filesystem: {
      kind: 'restricted',
      mode: paths.mode ?? DEFAULT_CHILD_WORKSPACE_MODE,
      writablePaths: [...(paths.writablePaths ?? [])],
      visiblePaths: [...(paths.visiblePaths ?? [])],
    },
    ...(paths.allowedCommands !== undefined ? { allowedCommands: [...paths.allowedCommands] } : {}),
    canCreateChildren: nested,
    // Creating children without being able to feed / drop / wait on them
    // is a trap, so the grant is the supervisor pair — not create alone.
    canManageChildren: nested,
    canWriteSharedMemory: false,
    canResolveApprovals: paths.approvesGuestRequests === true,
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
    allowedCommands: scoop.config?.allowedCommands,
    mode: childModeFromConfig(scoop.config?.workspaceMode),
    approvesGuestRequests: scoop.approvesGuestRequests === true,
    canCreateChildren: scoop.config?.canCreateChildren === true,
  });
}

function childModeFromConfig(raw: string | undefined): WorkspaceIsolationMode {
  if (raw === 'snapshot' || raw === 'shared-live') return raw;
  const parsed = parseWorkspaceMode(raw);
  return parsed.ok ? parsed.mode : DEFAULT_CHILD_WORKSPACE_MODE;
}

/** Derive the completion policy of a registered record. */
export function deriveCompletion(scoop: RegisteredScoop): CompletionPolicy {
  if (scoop.parentJid === null) return { mode: 'interactive' };
  if (scoop.notifyOnComplete === false) return { mode: 'silent' };
  return { mode: 'notify-parent' };
}

/**
 * Close policy of a child relative to its parent. Roots have no parent, so
 * they always report `cascade` (the field is ignored). Absent / anything
 * other than `'detach'` is cascade — today's default.
 */
export function deriveOnParentClose(scoop: RegisteredScoop): 'cascade' | 'detach' {
  if (scoop.parentJid === null) return 'cascade';
  return scoop.onParentClose === 'detach' ? 'detach' : 'cascade';
}

const CAPABILITY_FLAGS = [
  'canCreateChildren',
  'canManageChildren',
  'canWriteSharedMemory',
  'canResolveApprovals',
  'persistCommandGrants',
] as const;

/** Trailing-slash prefix form used by RestrictedFS grants. */
function asPrefix(path: string): string {
  const n = normalizePath(path);
  return n.endsWith('/') ? n : `${n}/`;
}

/**
 * True when every path reachable under `childPath` is also reachable under
 * `parentPath` (RestrictedFS prefix semantics: trailing slash, normalize).
 */
export function pathCoveredBy(childPath: string, parentPath: string): boolean {
  const child = asPrefix(childPath);
  const parent = asPrefix(parentPath);
  return child === parent || child.startsWith(parent);
}

function everyPathCoveredBy(
  childPaths: readonly string[],
  parentPaths: readonly string[]
): boolean {
  return childPaths.every((c) => parentPaths.some((p) => pathCoveredBy(c, p)));
}

/**
 * Readable reach for a restricted policy: writable paths are always readable
 * too (RestrictedFS merges them into the allow set).
 */
function readablePathsOf(fs: Extract<FileSystemPolicy, { kind: 'restricted' }>): readonly string[] {
  return [...fs.writablePaths, ...fs.visiblePaths];
}

/** `true` when the allow-list is absent or contains `*` (NOPASSWD Cmnd *). */
function isCommandListUnrestricted(cmds: readonly string[] | undefined): boolean {
  return cmds === undefined || cmds.includes('*');
}

/**
 * Child command grants must not widen past the parent. Unrestricted parent
 * (omitted / `*`) subsumes any child; a concrete parent list requires the
 * child to also be concrete and every entry to appear in the parent list.
 */
function isCommandSubset(
  child: readonly string[] | undefined,
  parent: readonly string[] | undefined
): boolean {
  if (isCommandListUnrestricted(parent)) return true;
  // Concrete parent list: child must also be concrete (not omitted / `*`).
  if (child === undefined || child.includes('*')) return false;
  const parentSet = new Set(parent);
  return child.every((c) => parentSet.has(c));
}

/**
 * When the parent is restricted, every child writable/visible grant must sit
 * under a parent grant of the same class (writable ⊆ parent's writable;
 * visible ⊆ parent's readable = writable ∪ visible). A `full-workspace`
 * parent subsumes any restricted child paths.
 */
function isFilesystemSubset(child: FileSystemPolicy, parent: FileSystemPolicy): boolean {
  if (child.kind === 'full-workspace') return parent.kind === 'full-workspace';
  if (parent.kind === 'full-workspace') return true;
  // restricted → restricted: path containment
  if (!everyPathCoveredBy(child.writablePaths, parent.writablePaths)) return false;
  if (!everyPathCoveredBy(child.visiblePaths, readablePathsOf(parent))) return false;
  return true;
}

/**
 * Invariant: `child capabilities ⊆ parent capabilities`. A child may never
 * hold a boolean capability its parent lacks, may not auto-allow sudo when
 * its parent must ask, may not see the full workspace when its parent is
 * restricted, and — once nesting is enabled — may not name filesystem paths
 * or shell commands outside the parent's sandbox.
 */
export function isPolicySubset(child: WorkUnitPolicy, parent: WorkUnitPolicy): boolean {
  for (const flag of CAPABILITY_FLAGS) {
    if (child[flag] && !parent[flag]) return false;
  }
  if (child.sudoDefaultDisposition === 'allow' && parent.sudoDefaultDisposition !== 'allow') {
    return false;
  }
  if (!isFilesystemSubset(child.filesystem, parent.filesystem)) return false;
  if (!isCommandSubset(child.allowedCommands, parent.allowedCommands)) return false;
  if (child.filesystem.kind === 'restricted' && parent.filesystem.kind === 'restricted') {
    if (workspaceModeRank(child.filesystem.mode) > workspaceModeRank(parent.filesystem.mode)) {
      return false;
    }
  }
  return true;
}

/**
 * Create-time gate for a child of `parent`. Roots skip this (they have no
 * parent to subset against). Throws when the parent cannot create children,
 * or when the child's derived policy is not ⊆ the parent's.
 */
export function assertChildPolicyAllowed(child: RegisteredScoop, parent: RegisteredScoop): void {
  const parentPolicy = derivePolicy(parent);
  const childPolicy = derivePolicy(child);
  if (!isPolicySubset(childPolicy, parentPolicy)) {
    throw new Error(
      `Child policy of "${child.name}" is not a subset of parent ${parent.jid} (isPolicySubset)`
    );
  }
  if (!parentPolicy.canCreateChildren) {
    throw new Error(
      `Work unit ${parent.jid} cannot create children (policy.canCreateChildren is false)`
    );
  }
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
 * `rootId`'s unit plus every unit it transitively owns, in registry order.
 * Empty when the root is no longer registered — the caller decides what an
 * empty scope means rather than silently widening back to everything.
 */
export function subtreeOf<T extends Pick<RegisteredScoop, 'jid' | 'parentJid'>>(
  units: readonly T[],
  rootId: WorkUnitId
): T[] {
  const owned = new Set<string>([rootId]);
  // One pass per generation: a child is admitted once its parent is, and the
  // depth of the ownership tree can never exceed the roster size. Order-
  // independent by construction — the answer does not depend on where a child
  // sits in the registry relative to its parent.
  for (let pass = 0; pass < units.length; pass++) {
    let grew = false;
    for (const unit of units) {
      if (owned.has(unit.jid)) continue;
      if (unit.parentJid !== null && owned.has(unit.parentJid)) {
        owned.add(unit.jid);
        grew = true;
      }
    }
    if (!grew) break;
  }
  return units.filter((unit) => owned.has(unit.jid));
}

/**
 * The nearest ancestor of `unit` that can settle sudo (`canResolveApprovals`),
 * walking the `parentJid` chain. Returns `undefined` when the chain dangles,
 * loops, or never hits a capable unit — callers fall back to a default root.
 *
 * Capability matches {@link derivePolicy}: roots always, children only when
 * `approvesGuestRequests` is set. A `canCreateChildren` supervisor alone is
 * not an approver.
 */
export function capableApproverOf<
  T extends Pick<RegisteredScoop, 'jid' | 'parentJid'> & {
    approvesGuestRequests?: boolean;
  },
>(units: Iterable<T>, unit: T | undefined): T | undefined {
  if (!unit?.parentJid) return undefined;
  const byJid = new Map<string, T>();
  for (const u of units) byJid.set(u.jid, u);
  const seen = new Set<string>();
  let current: T | undefined = byJid.get(unit.parentJid);
  while (current && !seen.has(current.jid)) {
    seen.add(current.jid);
    if (current.parentJid === null || current.approvesGuestRequests === true) return current;
    current = current.parentJid ? byJid.get(current.parentJid) : undefined;
  }
  return undefined;
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
