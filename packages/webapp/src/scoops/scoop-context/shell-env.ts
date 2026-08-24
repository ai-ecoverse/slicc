/**
 * Shell environment + lick addressing for one work unit.
 *
 * Owns: the env a unit's shell starts with (the `HOME`/`USER`/`PATH` isolation
 * pins) and the folder a unit stamps on the licks it produces.
 *
 * Changes when the on-disk layout of a unit moves or when lick routing gains a
 * new default — both directory-shaped questions, decided before any agent
 * exists, which is why they are plain functions over the record rather than
 * methods on the running context.
 */

import { DEFAULT_JSH_SEARCH_ROOTS } from '../../shell/jsh-discovery.js';
import { LICK_TARGET_ENV } from '../../shell/lick-target-env.js';
import type { WorkUnitDescriptor } from '../../work-unit/types.js';
import type { RegisteredScoop } from '../types.js';

/**
 * The env a scoop's shell starts with (#2085). Non-cone scoops pin:
 *
 * - HOME to their per-scoop home (created by ensureDirectoryStructure) — it
 *   is inside their writable ACL, unlike `/home`, which their RestrictedFS
 *   cannot even see;
 * - USER to the scoop folder;
 * - PATH with their own workspace roots ahead of the shared defaults, so
 *   scoop-local commands win a basename conflict (mirroring the old scan
 *   order, bounded to declared roots).
 *
 * The cone pins nothing — its shell resolves onboarding's `/home/<slug>`.
 * Secrets spread FIRST: a user-created secret can carry any POSIX name —
 * including PATH/HOME/USER — and must not override the isolation pins
 * (Codex P2 on #2143). Exported for tests.
 */
export function buildScoopShellEnv(
  isCone: boolean,
  folder: string,
  secretEnv: Record<string, string>,
  /** Folder a non-primary cone's untargeted licks default to (`SLICC_LICK_TARGET`). */
  lickTarget?: string
): Record<string, string> {
  if (isCone) return { ...secretEnv, ...(lickTarget ? { [LICK_TARGET_ENV]: lickTarget } : {}) };
  return {
    ...secretEnv,
    HOME: `/scoops/${folder}/home`,
    USER: folder,
    PATH: [
      '/usr/bin',
      `/scoops/${folder}/workspace/skills`,
      `/scoops/${folder}/workspace/bin`,
      ...DEFAULT_JSH_SEARCH_ROOTS,
    ].join(':'),
  };
}

/**
 * The lick target a unit stamps on licks it produces (background bash,
 * `fswatch`/`crontask` via `SLICC_LICK_TARGET`): its own folder for every
 * unit except the one root an untargeted lick already lands on, whose folder
 * is therefore not worth spending as a lick alias (#2272).
 *
 * That default root is `rootsOf(scoops)[0]` -- the *oldest* root, which is
 * what `host.ts` falls back to when an event carries no `targetScoop`. It is
 * deliberately NOT `isPrimaryRoot()`: that asks who holds the reserved `cone`
 * folder, and after the original primary is dropped `coneFolderFor()` hands
 * that freed folder to the next new cone. Such a cone would look primary
 * while the oldest *surviving* root is still the untargeted destination, so a
 * folder test would drop its stamp and post its `fswatch` events and
 * background-job completions into someone else's chat.
 */
export function ownLickTargetFor(
  unit: Pick<WorkUnitDescriptor, 'display'>,
  scoop: Pick<RegisteredScoop, 'parentJid' | 'folder' | 'jid'>,
  defaultLickRootJid: string | undefined
): string | undefined {
  if (unit.display.role === 'child') return scoop.folder;
  return scoop.jid === defaultLickRootJid ? undefined : scoop.folder;
}
