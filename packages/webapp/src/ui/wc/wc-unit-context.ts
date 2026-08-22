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
import { subtreeOf } from '../../transcript/collect.js';
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

/** Roots first (oldest first), then children in registry order. */
export function orderForSwitcher(
  scoops: readonly RegisteredScoop[],
  selectedJid?: string | null
): RegisteredScoop[] {
  const roots = rootsOf(scoops);
  const rootIds = new Set(roots.map((s) => s.jid));
  const rest = scoops.filter((s) => !rootIds.has(s.jid));
  // The selected cone's scoops come first (#2272): the strip reads
  // "cones, then what I am working in, then everything else".
  const selected = selectedJid ? scoops.find((s) => s.jid === selectedJid) : undefined;
  const selectedRoot = selected ? rootForSelection(scoops, selected) : undefined;
  if (!selectedRoot) return [...roots, ...rest];
  const mine = new Set(subtreeOf(scoops, selectedRoot.jid).map((s) => s.jid));
  return [
    ...roots,
    ...rest.filter((s) => mine.has(s.jid)),
    ...rest.filter((s) => !mine.has(s.jid)),
  ];
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
  let current = selected ? scoops.find((s) => s.jid === selected.jid) : undefined;
  // Bounded by the roster size: a cycle introduced by a corrupt record must
  // not spin here.
  for (let hops = 0; current && hops <= scoops.length; hops++) {
    if (isRootUnit(current)) return current;
    const parentJid = current.parentJid;
    current = scoops.find((s) => s.jid === parentJid);
  }
  return defaultRootOf(scoops);
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
