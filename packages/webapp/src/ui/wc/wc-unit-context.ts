/**
 * Presentation helpers for work units in the WC shell (#1666 phase 4).
 *
 * With several roots the UI can no longer say "the cone": every cone has a
 * label, a URL context and a short slug. The primary root (folder `cone`)
 * keeps the historical spellings — chip label `sliccy`, context `cone` — so
 * existing deep links, the welcome flow and the freezer keep working
 * unchanged; extra cones are addressed by their folder.
 */

import {
  isReadOnlyUnit,
  isRootSummary,
  orderUnits,
  ownerRootOf,
} from '../../work-unit/client/presentation.js';
import type { WorkUnitSummary } from '../../work-unit/client/types.js';
import { PRIMARY_CONE_FOLDER } from '../../work-unit/record.js';

/**
 * These helpers read the SUMMARY, not the record (#2382 D2a). Every field they
 * need — the ownership edge, the folder, the name, the assistant label — is on
 * the protocol's projection, so the same helper answers for a leader's own
 * roster and for a follower's, and the shell's selection can be one type.
 */
type UnitLike = Pick<WorkUnitSummary, 'role' | 'folder' | 'name' | 'assistantLabel'>;

/** The primary root keeps the historical spellings: chip `sliccy`, context `cone`. */
function isPrimaryRootSummary(unit: Pick<UnitLike, 'role' | 'folder'>): boolean {
  return isRootSummary(unit) && unit.folder === PRIMARY_CONE_FOLDER;
}

/** Switcher chip / tooltip label. */
export function switcherLabelFor(unit: Pick<UnitLike, 'role' | 'name' | 'assistantLabel'>): string {
  return isRootSummary(unit) ? unit.assistantLabel : unit.name;
}

/**
 * The `context` attribute of the chat thread, mirrored into `?ctx=`:
 * `cone` (primary root), `cone:<folder>` (extra root), `scoop:<name>` (child).
 */
export function threadContextFor(unit: UnitLike): string {
  if (isPrimaryRootSummary(unit)) return 'cone';
  return isRootSummary(unit) ? `cone:${unit.folder}` : `scoop:${unit.name}`;
}

/**
 * Short identifier used where the shell needs a stable unit name rather
 * than a label (lick backpressure notices, the `agent` command's caller).
 */
export function unitSlugFor(unit: UnitLike): string {
  if (isPrimaryRootSummary(unit)) return 'cone';
  return isRootSummary(unit) ? unit.folder : unit.name;
}

/** Resolve a thread/URL context back to a registered unit. */
export function unitForContext(
  units: readonly WorkUnitSummary[],
  ctx: string
): WorkUnitSummary | undefined {
  if (ctx.startsWith('scoop:')) {
    const name = ctx.slice('scoop:'.length);
    return units.find((unit) => !isRootSummary(unit) && unit.name === name);
  }
  if (ctx.startsWith('cone:')) {
    const folder = ctx.slice('cone:'.length);
    return units.find((unit) => isRootSummary(unit) && unit.folder === folder);
  }
  return defaultRootOf(units);
}

/** The primary root when present, else the oldest root. */
export function defaultRootOf(units: readonly WorkUnitSummary[]): WorkUnitSummary | undefined {
  return units.find(isPrimaryRootSummary) ?? units.find(isRootSummary);
}

/**
 * Strip order for a roster of records — cones first (oldest first), then the
 * selected cone's scoops, then everything else.
 *
 * The rule itself lives in `work-unit/client/presentation.ts` since #2274, so
 * the follower orders the same roster the same way (#2317). This is the
 * record-side entry point: project, order, project back.
 */
export function orderForSwitcher(
  units: readonly WorkUnitSummary[],
  selectedJid?: string | null
): WorkUnitSummary[] {
  return [...orderUnits(units, selectedJid)];
}

/**
 * The root a session-level action ("New chat", the freezer, clear-chat)
 * belongs to (#2272). A selected root is itself; a selected child resolves
 * to the root that owns it, walking the ownership edge (`parentJid`) so a
 * scoop-of-a-scoop still lands on its cone. Nothing selected — or a broken
 * chain — falls back to the default root, which is what these actions used
 * before multiple cones existed.
 */
export function rootForSelection(
  units: readonly WorkUnitSummary[],
  selected: Pick<WorkUnitSummary, 'id'> | null | undefined
): WorkUnitSummary | undefined {
  return ownerRootOf(units, selected?.id) ?? defaultRootOf(units);
}

/**
 * Folder of the root a URL/thread context addresses, or `null` when the
 * context is not a cone (`scoop:…`, `freezer:…`). An absent context means
 * the primary cone — that is what a bare boot deep-links to.
 */
export function rootFolderForContext(ctx: string | null | undefined): string | null {
  if (ctx == null || ctx === 'cone') return PRIMARY_CONE_FOLDER;
  if (ctx.startsWith('cone:')) return ctx.slice('cone:'.length) || PRIMARY_CONE_FOLDER;
  return null;
}

/** Resolve the root that owns a frozen archive's `cone` folder, if it still exists. */
export function rootForConeFolder(
  units: readonly WorkUnitSummary[],
  folder: string | undefined
): WorkUnitSummary | undefined {
  if (!folder) return defaultRootOf(units);
  return (
    units.find((unit) => isRootSummary(unit) && unit.folder === folder) ?? defaultRootOf(units)
  );
}

/**
 * Presentation role of a unit — the `type` the switcher descriptors already
 * carry (`SwitcherScoop.type`, `ScoopSummary` via `summaryIsRoot`). Derived
 * from the ownership edge, never from the legacy `isCone` flag.
 */
export type UnitRole = 'cone' | 'scoop';

/** The role of a registered unit: a root is a cone, anything owned is a scoop. */
export function unitRoleFor(unit: Pick<WorkUnitSummary, 'role'>): UnitRole {
  return isRootSummary(unit) ? 'cone' : 'scoop';
}

/**
 * Users never talk to a scoop (#2312). Selecting one opens a READ-ONLY
 * transcript: no composer, no queued pile, no model picker or thinking pill,
 * no error-card CTAs and no approval cards — every scoop request that needs
 * a human is routed to the cone that owns it instead.
 *
 * The rule itself lives on the protocol (`isReadOnlyUnit`); this is its
 * spelling in the UI's `cone`/`scoop` vocabulary. Leader and follower both
 * reach one answer, so neither grows a second code path.
 */
export function isReadOnlyRole(role: UnitRole): boolean {
  return isReadOnlyUnit({ role: role === 'cone' ? 'primary' : 'child' });
}
