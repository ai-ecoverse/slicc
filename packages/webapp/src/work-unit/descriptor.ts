/**
 * Pure projection of a `RegisteredScoop` (+ live tab state) onto a
 * {@link WorkUnitDescriptor}. No I/O, no globals — safe to call from tests,
 * the kernel, and (later) wire projections.
 */

import type { RegisteredScoop, ScoopTabState } from '../scoops/types.js';
import { deriveCompletion, derivePolicy, isRootUnit, rootOwnerOf, rootsOf } from './policy.js';
import { isPrimaryRoot, PRIMARY_CONE_FOLDER } from './record.js';
import { statusFromTab, type WorkUnitDescriptor, type WorkUnitWorkspace } from './types.js';

/** Home directory of every non-primary cone: `/cones/<folder>` (#2271). */
export const EXTRA_CONE_HOME_ROOT = '/cones';

/**
 * The skills library, shared by every unit — deliberately NOT per-cone.
 *
 * Skills are a library (`/usr/bin`, not `~`): `upskill` installs into it,
 * `jsh` / workflow / sprinkle discovery scan it, and the `PATH` of every
 * scoop shell names it. Giving each cone a private copy would fork all of
 * those roots for no gain — an extra cone's `upskill` would still land here
 * while its agent read a stale bundled copy. Per-cone privacy covers working
 * files and memory; the library stays common.
 */
export const SKILLS_LIBRARY_DIR = '/workspace/skills';

/**
 * Filesystem coordinates for a unit. These encode the directory convention
 * the runtime uses today (`scoop-context.ts`); computing them in one place
 * is what lets Phase 3 replace the scattered `isCone ? '/workspace' : …`
 * ternaries.
 *
 * Three layouts (#2271):
 *
 * - primary cone (folder `cone`) — `/workspace`, unchanged since forever, so
 *   every existing profile, mount, deep link and skill path keeps working;
 * - extra cone — `/cones/<folder>/workspace` with its own `CLAUDE.md`, so two
 *   cones neither list each other's files by default nor append to one memory;
 * - scoop — `/scoops/<folder>/workspace`, unchanged.
 *
 * `scratch` (`/tmp`) stays shared between cones: it is the float-wide scratch
 * space every unit already writes to (`builtinScoopGrants`).
 */
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

/**
 * Coordinates of the primary cone. The historical layout, and the fallback
 * for the float-wide paths that predate multiple cones (the freezer's
 * `session-cone` archive + its memory extraction, the legacy shared-memory
 * migration).
 */
export const PRIMARY_WORKSPACE: WorkUnitWorkspace = Object.freeze(
  workspaceFor({ parentJid: null, folder: PRIMARY_CONE_FOLDER })
);

/**
 * Workspace of the root that owns `unit` — the cone whose files a spawned
 * child should read and whose tree the UI should show while that unit is
 * selected. Falls back to the default (oldest) root, then to the primary
 * cone's layout, so a dangling ownership edge can never hand out a child's
 * `/scoops/<folder>` as a workspace (#2271).
 */
export function ownerWorkspaceFor<
  T extends Pick<RegisteredScoop, 'jid' | 'parentJid' | 'folder' | 'addedAt'>,
>(units: Iterable<T>, unit: T | undefined): WorkUnitWorkspace {
  const all = [...units];
  const owner = rootOwnerOf(all, unit) ?? rootsOf(all)[0];
  return owner ? workspaceFor(owner) : PRIMARY_WORKSPACE;
}

/**
 * Read-only roots a delegated child gets by default: the workspace of the cone
 * that spawned it, plus the shared skills library when that lives outside it
 * (#2271). Under the primary cone the library is already inside `/workspace`,
 * so the list stays the historical `['/workspace/']`.
 */
export function defaultChildVisibleRoots(owner: WorkUnitWorkspace): string[] {
  const root = `${owner.root}/`;
  const skills = `${SKILLS_LIBRARY_DIR}/`;
  return skills.startsWith(root) ? [root] : [root, skills];
}

/** Project a record (and optional live tab) onto a descriptor. */
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
    policy: derivePolicy(scoop),
    completion: deriveCompletion(scoop),
  };
}
