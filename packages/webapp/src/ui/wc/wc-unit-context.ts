/**
 * Presentation helpers for work units in the WC shell (#1666 phase 4).
 *
 * With several roots the UI can no longer say "the cone": every cone has a
 * label, a URL context and a short slug. The primary root (folder `cone`)
 * keeps the historical spellings — chip label `sliccy`, context `cone` — so
 * existing deep links, the welcome flow and the freezer keep working
 * unchanged; extra cones are addressed by their folder.
 */

import type { RegisteredScoop } from '../../scoops/types.js';
import { recordToWorkUnitSummary } from '../../work-unit/client/from-record.js';
import { isReadOnlyUnit, orderUnits, ownerRootOf } from '../../work-unit/client/presentation.js';
import { isRootUnit, rootsOf } from '../../work-unit/policy.js';
import { isPrimaryRoot, PRIMARY_CONE_FOLDER } from '../../work-unit/record.js';

type UnitLike = Pick<RegisteredScoop, 'parentJid' | 'folder' | 'name' | 'assistantLabel'>;

/** Switcher chip / tooltip label. */
export function switcherLabelFor(
  scoop: Pick<UnitLike, 'parentJid' | 'name' | 'assistantLabel'>
): string {
  return isRootUnit(scoop) ? scoop.assistantLabel : scoop.name;
}

/**
 * The `context` attribute of the chat thread, mirrored into `?ctx=`:
 * `cone` (primary root), `cone:<folder>` (extra root), `scoop:<name>` (child).
 */
export function threadContextFor(scoop: UnitLike): string {
  if (isPrimaryRoot(scoop)) return 'cone';
  return isRootUnit(scoop) ? `cone:${scoop.folder}` : `scoop:${scoop.name}`;
}

/**
 * Short identifier used where the shell needs a stable unit name rather
 * than a label (lick backpressure notices, the `agent` command's caller).
 */
export function unitSlugFor(scoop: UnitLike): string {
  if (isPrimaryRoot(scoop)) return 'cone';
  return isRootUnit(scoop) ? scoop.folder : scoop.name;
}

/** Resolve a thread/URL context back to a registered unit. */
export function unitForContext(
  scoops: readonly RegisteredScoop[],
  ctx: string
): RegisteredScoop | undefined {
  if (ctx.startsWith('scoop:')) {
    const name = ctx.slice('scoop:'.length);
    return scoops.find((s) => !isRootUnit(s) && s.name === name);
  }
  if (ctx.startsWith('cone:')) {
    const folder = ctx.slice('cone:'.length);
    return scoops.find((s) => isRootUnit(s) && s.folder === folder);
  }
  return defaultRootOf(scoops);
}

/** The primary root when present, else the oldest root. */
export function defaultRootOf(scoops: readonly RegisteredScoop[]): RegisteredScoop | undefined {
  return scoops.find((s) => isPrimaryRoot(s)) ?? rootsOf(scoops)[0];
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
  scoops: readonly RegisteredScoop[],
  selectedJid?: string | null
): RegisteredScoop[] {
  const byId = new Map(scoops.map((scoop) => [scoop.jid, scoop]));
  const ordered = orderUnits(
    scoops.map((scoop) => recordToWorkUnitSummary(scoop)),
    selectedJid
  );
  return ordered.flatMap((unit) => {
    const scoop = byId.get(unit.id);
    return scoop ? [scoop] : [];
  });
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
  scoops: readonly RegisteredScoop[],
  selected: Pick<RegisteredScoop, 'jid' | 'parentJid'> | null | undefined
): RegisteredScoop | undefined {
  const owner = ownerRootOf(
    scoops.map((scoop) => recordToWorkUnitSummary(scoop)),
    selected?.jid
  );
  return (owner && scoops.find((scoop) => scoop.jid === owner.id)) ?? defaultRootOf(scoops);
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
  scoops: readonly RegisteredScoop[],
  folder: string | undefined
): RegisteredScoop | undefined {
  if (!folder) return defaultRootOf(scoops);
  return scoops.find((s) => isRootUnit(s) && s.folder === folder) ?? defaultRootOf(scoops);
}

/**
 * Presentation role of a unit — the `type` the switcher descriptors already
 * carry (`SwitcherScoop.type`, `ScoopSummary` via `summaryIsRoot`). Derived
 * from the ownership edge, never from the legacy `isCone` flag.
 */
export type UnitRole = 'cone' | 'scoop';

/** The role of a registered unit: a root is a cone, anything owned is a scoop. */
export function unitRoleFor(unit: Pick<RegisteredScoop, 'parentJid'>): UnitRole {
  return isRootUnit(unit) ? 'cone' : 'scoop';
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
