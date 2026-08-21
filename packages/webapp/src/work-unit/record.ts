/**
 * Record-level helpers that keep `RegisteredScoop`'s presentation fields
 * consistent with the ownership edge (#1666, Phase 3).
 *
 * `isCone` / `type` stay on the record and on the wire for followers, but
 * they are *derived* — written here from `parentJid`, never branched on by
 * kernel or scoop lifecycle code. The final phase deletes them.
 */

import type { RegisteredScoop } from '../scoops/types.js';
import { isRootUnit } from './policy.js';

/**
 * Rewrite the derived presentation fields from the ownership edge. Applied
 * on register and on restore so a record can never say `isCone: true` while
 * naming a parent (or vice versa). Mutates and returns `scoop`.
 */
export function normalizeScoopRecord(scoop: RegisteredScoop): RegisteredScoop {
  const root = isRootUnit(scoop);
  scoop.isCone = root;
  scoop.type = root ? 'cone' : 'scoop';
  if (root) {
    // A root is addressed directly; trigger patterns are a child concept.
    scoop.trigger = undefined;
    scoop.requiresTrigger = false;
    scoop.assistantLabel = scoop.assistantLabel || 'sliccy';
  }
  return scoop;
}

/** Folder of the primary root — the one a fresh profile bootstraps. */
export const PRIMARY_CONE_FOLDER = 'cone';

/**
 * The persisted chat/session store key of a unit: `session-<folder>`. The
 * primary root's folder is `cone`, so its history stays under the historical
 * `session-cone` key; every other unit — extra cones included — gets its own.
 */
export function chatSessionIdFor(scoop: Pick<RegisteredScoop, 'folder'>): string {
  return `session-${scoop.folder}`;
}

/** `true` for the primary root (folder `cone`): URL context `cone`, session `session-cone`. */
export function isPrimaryRoot(scoop: Pick<RegisteredScoop, 'parentJid' | 'folder'>): boolean {
  return isRootUnit(scoop) && scoop.folder === PRIMARY_CONE_FOLDER;
}

/** Lower-case, dash-separated, ASCII-only slug of a user-typed name. */
export function slugifyUnitName(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/\p{M}+/gu, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'cone'
  );
}

/**
 * Storage folder for a new root. The first root is the primary `cone`; later
 * ones are `cone-<slug>`, de-duplicated against the existing registry so two
 * cones named alike never share a session key.
 */
export function coneFolderFor(
  name: string,
  existing: Iterable<Pick<RegisteredScoop, 'folder'>>
): string {
  const taken = new Set<string>();
  for (const scoop of existing) taken.add(scoop.folder);
  if (!taken.has(PRIMARY_CONE_FOLDER)) return PRIMARY_CONE_FOLDER;
  const base = `cone-${slugifyUnitName(name)}`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Process-owner label for the kernel process table (`ps` shows `cone` /
 * `scoop`). Presentation of the role, not a capability.
 */
export function processOwnerKindFor(scoop: Pick<RegisteredScoop, 'parentJid'>): 'cone' | 'scoop' {
  return isRootUnit(scoop) ? 'cone' : 'scoop';
}

/**
 * Human label used in logs, message sources and prompts: `cone` for a
 * root, the unit's name for a child.
 */
export function sourceLabelFor(
  scoop: Pick<RegisteredScoop, 'parentJid' | 'name' | 'folder'>
): string {
  return isRootUnit(scoop) ? 'cone' : (scoop.name ?? scoop.folder);
}
