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

export function isRootUnit(scoop: Pick<RegisteredScoop, 'parentJid'>): boolean {
  return scoop.parentJid === null;
}

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

export function delegatedChildPolicy(
  parentId: WorkUnitId,
  paths: {
    writablePaths?: readonly string[];
    visiblePaths?: readonly string[];

    mode?: WorkspaceIsolationMode;

    allowedCommands?: readonly string[];

    approvesGuestRequests?: boolean;

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

    canManageChildren: nested,
    canWriteSharedMemory: false,
    canResolveApprovals: paths.approvesGuestRequests === true,
    approvalAuthority: { parentId },
    sudoDefaultDisposition: 'require-approval',
    persistCommandGrants: false,
  };
}

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

export function deriveCompletion(scoop: RegisteredScoop): CompletionPolicy {
  if (scoop.parentJid === null) return { mode: 'interactive' };
  if (scoop.notifyOnComplete === false) return { mode: 'silent' };
  return { mode: 'notify-parent' };
}

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

function asPrefix(path: string): string {
  const n = normalizePath(path);
  return n.endsWith('/') ? n : `${n}/`;
}

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

function readablePathsOf(fs: Extract<FileSystemPolicy, { kind: 'restricted' }>): readonly string[] {
  return [...fs.writablePaths, ...fs.visiblePaths];
}

function isCommandListUnrestricted(cmds: readonly string[] | undefined): boolean {
  return cmds === undefined || cmds.includes('*');
}

function isCommandSubset(
  child: readonly string[] | undefined,
  parent: readonly string[] | undefined
): boolean {
  if (isCommandListUnrestricted(parent)) return true;

  if (child === undefined || child.includes('*')) return false;
  const parentSet = new Set(parent);
  return child.every((c) => parentSet.has(c));
}

function isFilesystemSubset(child: FileSystemPolicy, parent: FileSystemPolicy): boolean {
  if (child.kind === 'full-workspace') return parent.kind === 'full-workspace';
  if (parent.kind === 'full-workspace') return true;

  if (!everyPathCoveredBy(child.writablePaths, parent.writablePaths)) return false;
  if (!everyPathCoveredBy(child.visiblePaths, readablePathsOf(parent))) return false;
  return true;
}

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

export function childrenOf<T extends Pick<RegisteredScoop, 'parentJid'>>(
  scoops: Iterable<T>,
  id: WorkUnitId
): T[] {
  const out: T[] = [];
  for (const scoop of scoops) if (scoop.parentJid === id) out.push(scoop);
  return out;
}

export function subtreeOf<T extends Pick<RegisteredScoop, 'jid' | 'parentJid'>>(
  units: readonly T[],
  rootId: WorkUnitId
): T[] {
  const owned = new Set<string>([rootId]);

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

export type OwnershipChain<T> =
  | { kind: 'root'; root: T }
  | { kind: 'dangling' }
  | { kind: 'cycle' };

export function ownershipChainOf<T extends Pick<RegisteredScoop, 'jid' | 'parentJid'>>(
  units: Iterable<T>,
  unit: T | undefined
): OwnershipChain<T> {
  if (!unit) return { kind: 'dangling' };
  const byJid = new Map<string, T>();
  for (const u of units) byJid.set(u.jid, u);
  const seen = new Set<string>();
  let current: T = unit;
  while (current.parentJid !== null) {
    if (seen.has(current.jid)) return { kind: 'cycle' };
    seen.add(current.jid);
    const parent = byJid.get(current.parentJid);
    if (!parent) return { kind: 'dangling' };
    current = parent;
  }
  return { kind: 'root', root: current };
}

export function rootOwnerOf<T extends Pick<RegisteredScoop, 'jid' | 'parentJid'>>(
  units: Iterable<T>,
  unit: T | undefined
): T | undefined {
  const chain = ownershipChainOf(units, unit);
  return chain.kind === 'root' ? chain.root : undefined;
}

export function rootsOf<T extends Pick<RegisteredScoop, 'parentJid' | 'addedAt' | 'jid'>>(
  scoops: Iterable<T>
): T[] {
  const out: T[] = [];
  for (const scoop of scoops) if (scoop.parentJid === null) out.push(scoop);
  return out.sort((a, b) => a.addedAt.localeCompare(b.addedAt) || a.jid.localeCompare(b.jid));
}
