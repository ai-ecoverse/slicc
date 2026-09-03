/**
 * Pure projection of a `RegisteredScoop` (+ live tab state) onto a
 * {@link WorkUnitDescriptor}. No I/O, no globals — safe to call from tests,
 * the kernel, and (later) wire projections.
 */

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
 * Root of the float-wide scratch tree. Stays shared and stays writable by
 * everyone — `ALWAYS_WRITABLE_PREFIXES` (`fs/restricted-fs.ts`) and
 * `BUILTIN_SCOOP_GRANTS` (`base/sudoers.ts`) both key off this literal, and
 * every persisted `writablePaths: ['/tmp/']` on disk names it.
 */
export const TMP_ROOT = '/tmp';

/**
 * A unit's own scratch directory — what its shell publishes as `$TMPDIR` and
 * what `mktemp` resolves against (#2267).
 *
 * ```
 * cone  cone         /tmp/cone
 * cone  cone-adobe   /tmp/cone-adobe
 * scoop review       /tmp/cone/review      ← nested inside its owning cone's
 * ```
 *
 * **This is a convention, not a sandbox.** `/tmp` remains shared and writable
 * by every unit; what a unit gets here is a directory it can call its own, not
 * one nobody else can reach. Enforcing the boundary would mean narrowing the
 * grant in `restricted-fs.ts` AND `sudoers.ts` together, which is a separate
 * decision — see [#2568](https://github.com/ai-ecoverse/slicc/issues/2568).
 *
 * Two things follow from living UNDER `/tmp` rather than beside the unit's
 * workspace (the alternative weighed in #2568):
 *
 * - the two grant layers keep working untouched, and so does every scoop
 *   record already persisted with `writablePaths: ['/tmp/']`;
 * - a scoop's scratch is INSIDE its cone's, so "New chat" on a cone disposes
 *   of its children's scratch in the same subtree delete, and the documented
 *   `agent /tmp "…" >> "$TMPDIR/out.txt"` handoff still lets the cone read
 *   back what its scoop wrote.
 *
 * Folders are globally unique (`uniqueFolder`), so nesting cannot collide.
 * A scoop whose ownership edge is dangling falls back to the default (oldest)
 * root, then to the primary cone — never to a bare `/tmp`, which would hand it
 * the whole shared tree as its own.
 */
export function tmpDirFor<
  T extends Pick<RegisteredScoop, 'jid' | 'parentJid' | 'folder' | 'addedAt'>,
>(units: Iterable<T>, unit: T | undefined): string {
  if (!unit) return `${TMP_ROOT}/${PRIMARY_CONE_FOLDER}`;
  if (isRootUnit(unit)) return `${TMP_ROOT}/${unit.folder}`;
  const all = [...units];
  const owner = rootOwnerOf(all, unit) ?? rootsOf(all)[0];
  return `${TMP_ROOT}/${owner?.folder ?? PRIMARY_CONE_FOLDER}/${unit.folder}`;
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
export function defaultChildVisibleRoots(owner: Pick<WorkUnitWorkspace, 'root'>): string[] {
  const root = `${owner.root}/`;
  const skills = `${SKILLS_LIBRARY_DIR}/`;
  return skills.startsWith(root) ? [root] : [root, skills];
}

/**
 * Default `visiblePaths` / `writablePaths` for a child created under `mode`.
 *
 * `shared-readonly` is today's scoop_scoop injection. `private` is the
 * isolated sandbox: own `/scoops/<folder>/` only — no parent workspace, no
 * implicit `/shared/`. Explicit caller lists still replace these.
 */
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

/**
 * Named sharing policy for a unit. Roots project as `shared-live` (they hold
 * the unrestricted live VFS). Children default to `shared-readonly` when the
 * record predates {@link RegisteredScoop.config.workspaceMode}.
 */
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
    workspaceHandle: workspaceHandleFor(scoop),
    policy: derivePolicy(scoop),
    completion: deriveCompletion(scoop),
    onParentClose: deriveOnParentClose(scoop),
  };
}
