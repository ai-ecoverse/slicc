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
import { pickDefaultRoot } from '../../work-unit/default-root.js';
import { isRootUnit, rootsOf } from '../../work-unit/policy.js';
import { isPrimaryRoot } from '../../work-unit/record.js';

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

/**
 * Resolve a thread/URL context back to a registered unit. Every context
 * {@link threadContextFor} emits round-trips exactly — including the bare
 * `cone`, which names the PRIMARY root, not whichever root is starred as the
 * event default. Only an absent or unrecognised context falls through to
 * {@link defaultRootOf}.
 */
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
  if (ctx === 'cone') return scoops.find((s) => isPrimaryRoot(s));
  return defaultRootOf(scoops);
}

/** The user-selected default root, else the primary root, else the oldest. */
export function defaultRootOf(scoops: readonly RegisteredScoop[]): RegisteredScoop | undefined {
  return pickDefaultRoot(scoops);
}

/** Roots first (oldest first), then children in registry order. */
export function orderForSwitcher(scoops: readonly RegisteredScoop[]): RegisteredScoop[] {
  const roots = rootsOf(scoops);
  const rootIds = new Set(roots.map((s) => s.jid));
  return [...roots, ...scoops.filter((s) => !rootIds.has(s.jid))];
}
