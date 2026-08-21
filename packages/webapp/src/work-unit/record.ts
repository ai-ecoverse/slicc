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

/**
 * The persisted chat/session store key of a unit. A root's history lives
 * under the historical `session-cone` key; a child's under its folder.
 */
export function chatSessionIdFor(scoop: Pick<RegisteredScoop, 'parentJid' | 'folder'>): string {
  return isRootUnit(scoop) ? 'session-cone' : `session-${scoop.folder}`;
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
