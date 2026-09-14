import type { RegisteredScoop, ScoopTabState } from '../scoops/types.js';
import {
  deriveCompletion,
  deriveOnParentClose,
  derivePolicy,
  isRootUnit,
  rootOwnerOf,
  rootsOf,
} from './policy.js';
import { isPrimaryRoot, PRIMARY_CONE_FOLDER } from './record.js';
import {
  statusFromTab,
  type WorkspaceHandle,
  type WorkspaceIsolationMode,
  type WorkUnitDescriptor,
  type WorkUnitWorkspace,
} from './types.js';
import { DEFAULT_CHILD_WORKSPACE_MODE, type ImplementedWorkspaceMode } from './workspace-mode.js';

export const EXTRA_CONE_HOME_ROOT = '/cones';

export const SKILLS_LIBRARY_DIR = '/workspace/skills';

export function workspaceFor(
  scoop: Pick<RegisteredScoop, 'parentJid' | 'folder'>
): WorkUnitWorkspace {
  if (isRootUnit(scoop)) {
    if (isPrimaryRoot(scoop)) {
      return { root: '/workspace', memoryPath: '/workspace/CLAUDE.md', scratch: '/tmp' };
    }
    const home = `${EXTRA_CONE_HOME_ROOT}/${scoop.folder}`;
    return { root: `${home}/workspace`, memoryPath: `${home}/CLAUDE.md`, scratch: '/tmp' };
  }
  const home = `/scoops/${scoop.folder}`;
  return { root: `${home}/workspace`, memoryPath: `${home}/CLAUDE.md`, scratch: home };
}

export const TMP_ROOT = '/tmp';

export function tmpDirFor<
  T extends Pick<RegisteredScoop, 'jid' | 'parentJid' | 'folder' | 'addedAt'>,
>(units: Iterable<T>, unit: T | undefined): string {
  if (!unit) return `${TMP_ROOT}/${PRIMARY_CONE_FOLDER}`;
  if (isRootUnit(unit)) return `${TMP_ROOT}/${unit.folder}`;
  const all = [...units];
  const owner = rootOwnerOf(all, unit) ?? rootsOf(all)[0];
  return `${TMP_ROOT}/${owner?.folder ?? PRIMARY_CONE_FOLDER}/${unit.folder}`;
}

export const PRIMARY_WORKSPACE: WorkUnitWorkspace = Object.freeze(
  workspaceFor({ parentJid: null, folder: PRIMARY_CONE_FOLDER })
);

export function ownerWorkspaceFor<
  T extends Pick<RegisteredScoop, 'jid' | 'parentJid' | 'folder' | 'addedAt'>,
>(units: Iterable<T>, unit: T | undefined): WorkUnitWorkspace {
  const all = [...units];
  const owner = rootOwnerOf(all, unit) ?? rootsOf(all)[0];
  return owner ? workspaceFor(owner) : PRIMARY_WORKSPACE;
}

export function defaultChildVisibleRoots(owner: Pick<WorkUnitWorkspace, 'root'>): string[] {
  const root = `${owner.root}/`;
  const skills = `${SKILLS_LIBRARY_DIR}/`;
  return skills.startsWith(root) ? [root] : [root, skills];
}

export function defaultChildPathsForMode(
  mode: ImplementedWorkspaceMode,
  folder: string,
  owner: Pick<WorkUnitWorkspace, 'root'>,
  from?: string
): { visiblePaths: string[]; writablePaths: string[] } {
  const sandbox = `/scoops/${folder}/`;
  if (mode === 'private') {
    return { visiblePaths: [], writablePaths: [sandbox] };
  }
  return {
    visiblePaths: defaultChildVisibleRoots({ root: from ?? owner.root }),
    writablePaths: [sandbox, '/shared/'],
  };
}

export function workspaceHandleFor(
  scoop: Pick<RegisteredScoop, 'parentJid' | 'folder' | 'config'>
): WorkspaceHandle {
  const { root } = workspaceFor(scoop);
  return {
    workspaceId: root,
    root,
    access: accessFor(scoop),
  };
}

function accessFor(scoop: Pick<RegisteredScoop, 'parentJid' | 'config'>): WorkspaceIsolationMode {
  if (isRootUnit(scoop)) return 'shared-live';
  const raw = scoop.config?.workspaceMode;
  if (
    raw === 'private' ||
    raw === 'shared-readonly' ||
    raw === 'snapshot' ||
    raw === 'shared-live'
  ) {
    return raw;
  }
  return DEFAULT_CHILD_WORKSPACE_MODE;
}

export function toDescriptor(scoop: RegisteredScoop, tab?: ScoopTabState): WorkUnitDescriptor {
  const root = isRootUnit(scoop);
  return {
    id: scoop.jid,
    parentId: scoop.parentJid,
    name: scoop.name,
    folder: scoop.folder,
    status: statusFromTab(tab?.status),
    display: {
      role: root ? 'primary' : 'child',
      label: scoop.assistantLabel,
    },
    workspace: workspaceFor(scoop),
    workspaceHandle: workspaceHandleFor(scoop),
    policy: derivePolicy(scoop),
    completion: deriveCompletion(scoop),
    onParentClose: deriveOnParentClose(scoop),
  };
}
