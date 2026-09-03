/**
 * The ONE implementation of how a roster of work units is ordered and
 * rendered into the tab strip (#2274).
 *
 * Before this module the leader ordered with `orderForSwitcher`
 * (`ui/wc/wc-unit-context.ts`) and the follower with `orderByOwner`
 * (`ui/wc/wc-tray-scoops.ts`), and each built its own descriptors
 * (`toSwitcherScoops` / `toFollowerSwitcherScoops`). Three orderings existed
 * at once before #2317; this is what stops a fourth.
 *
 * Everything here is pure and transport-free — it renders
 * {@link WorkUnitSummary}, which both adapters produce, and takes the accent
 * colour as an injected function because the palette lives in the `ui/` layer
 * and this module sits below it.
 */

import type { WorkUnitModel } from '../../scoops/types.js';
import type { WorkUnitId, WorkUnitPresentationState, WorkUnitSummary } from './types.js';

/**
 * Strip descriptor. Structurally the shell's `SwitcherScoop`
 * (`ui/wc/wc-shell.ts`); declared here so this module does not import UP the
 * layer stack into `ui/`.
 */
export interface WorkUnitTabDescriptor {
  key: string;
  type: 'cone' | 'scoop';
  color: string;
  label: string;
  eyes: 'open' | 'dead' | 'none';
  state: WorkUnitPresentationState;
  /** 0–100 context-window fullness. */
  fill: number;
  phase?: 'thinking' | 'tool';
  awaiting?: boolean;
}

/** A unit is a root (cone) when its role says so — never the wire's shape. */
export function isRootSummary(unit: Pick<WorkUnitSummary, 'role'>): boolean {
  return unit.role === 'primary';
}

/**
 * The model the shell should show for `id` — the model of the CONE that owns
 * it (#2310). Selecting a scoop shows its cone's model, because that is the
 * unit the picker writes to.
 *
 * **Absent is "not known yet", never "no model" (#2329).** A unit's model
 * reaches the shell from a roster that can legitimately arrive without it: a
 * follower's leader may predate the per-unit field (`ScoopSummary.model` is
 * optional on the wire), the record may not be backfilled, and a catalog that
 * has not warmed up yet answers for nothing. Reading absence as an answer is
 * what latched a follower's pill empty for a whole session, so `previous` is
 * carried forward instead and the caller keeps rendering what it had.
 *
 * The identity is all this decides. A display NAME and the reasoning
 * capability come from the provider catalog, which is leader-global on both
 * sides — `resolveModelById` locally, the tray's `models.list` remotely — and
 * is deliberately not on the client protocol.
 */
export function modelForUnit(
  units: readonly WorkUnitSummary[],
  id: WorkUnitId | null | undefined,
  previous?: WorkUnitModel
): WorkUnitModel | undefined {
  // The owning cone answers; a unit whose chain is unknown or broken answers
  // for itself, which is what `rootForSelection(roster, scoop) ?? scoop` did.
  const owner = ownerRootOf(units, id) ?? units.find((unit) => unit.id === id);
  return owner?.model ?? previous;
}

/**
 * The root that owns `id` — itself when `id` IS a root, `undefined` when the
 * chain is unknown or broken.
 *
 * Replaces `rootForSelection` (leader) and `rootOfSummary` (follower): the
 * same bounded walk, written once. The loop is bounded by the roster size so
 * a cycle from a corrupt record or a malicious wire cannot spin here.
 */
export function ownerRootOf(
  units: readonly WorkUnitSummary[],
  id: WorkUnitId | null | undefined
): WorkUnitSummary | undefined {
  let current = id ? units.find((unit) => unit.id === id) : undefined;
  for (let hops = 0; current && hops <= units.length; hops++) {
    if (isRootSummary(current)) return current;
    const parentId = current.parentId;
    current = parentId ? units.find((unit) => unit.id === parentId) : undefined;
  }
  return undefined;
}

/** Depth-first children of `owner`, skipping anything already placed. */
function descendantsOf(
  units: readonly WorkUnitSummary[],
  owner: WorkUnitSummary,
  placed: Set<string>,
  out: WorkUnitSummary[]
): WorkUnitSummary[] {
  for (const unit of units) {
    if (unit.parentId === owner.id && !placed.has(unit.id)) {
      placed.add(unit.id);
      out.push(unit);
      descendantsOf(units, unit, placed, out);
    }
  }
  return out;
}

/**
 * Strip order: every root first (oldest first, see {@link orderRoots}), then the
 * SELECTED root's descendants depth-first, then every other root's
 * descendants in root order, then anything whose owner is unknown, in the
 * order the transport gave it.
 *
 * This is the follower's `orderByOwner` promoted to the protocol. The
 * leader's `orderForSwitcher` split the same roster into "selected subtree"
 * and "the rest" but kept registry order inside each half, which reads as
 * "cone, its scoops, next cone" only as long as registry order happens to be
 * owner-grouped. Depth-first descendants already cover an explicit
 * nested-delegation grant (`canCreateChildren`); with one cone and no grant
 * both reduce to "cone, then its scoops in registry order".
 *
 * A roster where NO unit carries an edge comes from a leader too old to send
 * one: there is nothing to group by, so roots simply come first and everything
 * else keeps leader order.
 */
export function orderUnits(
  units: readonly WorkUnitSummary[],
  selectedId?: WorkUnitId | null
): readonly WorkUnitSummary[] {
  if (!units.some((unit) => unit.parentId !== undefined)) {
    const roots = orderRoots(units.filter(isRootSummary));
    return [...roots, ...units.filter((unit) => !isRootSummary(unit))];
  }
  const placed = new Set<string>();
  const roots = orderRoots(units.filter(isRootSummary));
  for (const root of roots) placed.add(root.id);
  const selectedRoot = ownerRootOf(units, selectedId);
  const mine = selectedRoot ? descendantsOf(units, selectedRoot, placed, []) : [];
  const others = roots.flatMap((root) => descendantsOf(units, root, placed, []));
  const tail = units.filter((unit) => !placed.has(unit.id));
  return [...roots, ...mine, ...others, ...tail];
}

/**
 * Roots oldest first when every one of them carries a timestamp, else in the
 * order the transport gave them.
 *
 * The all-or-nothing test matters: sorting a roster where only some units
 * carry `addedAt` would interleave a real ordering with a positional one and
 * produce something neither side ever rendered.
 */
function orderRoots(roots: readonly WorkUnitSummary[]): WorkUnitSummary[] {
  if (roots.length < 2 || !roots.every((root) => root.addedAt)) return [...roots];
  return [...roots].sort(
    (a, b) => (a.addedAt ?? '').localeCompare(b.addedAt ?? '') || a.id.localeCompare(b.id)
  );
}

/**
 * Users never talk to a child (#2312). Selecting one opens a READ-ONLY
 * transcript: no composer, no queued pile, no model picker, no error-card
 * CTAs and no approval cards — everything a scoop needs from a human is
 * routed to the cone that owns it.
 *
 * This is the ONE place that rule lives. `isReadOnlyRole` (`ui/wc/
 * wc-unit-context.ts`) is the UI vocabulary's spelling of it and delegates
 * here, so leader and follower cannot grow two answers.
 */
export function isReadOnlyUnit(unit: Pick<WorkUnitSummary, 'role'>): boolean {
  return unit.role === 'child';
}

function eyesFor(state: WorkUnitPresentationState): WorkUnitTabDescriptor['eyes'] {
  if (state === 'broken') return 'dead';
  if (state === 'initializing') return 'none';
  return 'open';
}

/**
 * Render an ordered roster into strip descriptors. `colorFor` is injected
 * because `scoopColor` lives in `ui/`; every caller passes the same function,
 * so the hue is still derived once.
 */
export function toTabDescriptors(
  units: readonly WorkUnitSummary[],
  selectedId: WorkUnitId | null | undefined,
  colorFor: (unit: { isRoot: boolean; name: string }) => string
): WorkUnitTabDescriptor[] {
  return orderUnits(units, selectedId).map((unit) => {
    const isRoot = isRootSummary(unit);
    return {
      key: unit.id,
      type: isRoot ? 'cone' : 'scoop',
      color: colorFor({ isRoot, name: unit.name }),
      label: isRoot ? unit.assistantLabel : unit.name,
      eyes: eyesFor(unit.state),
      state: unit.state,
      fill: unit.fill,
      // Both refinements are only meaningful alongside the state they refine;
      // an adapter that lets one through on the wrong state would render a
      // pin on an idle tab.
      ...(unit.state === 'working' && unit.phase ? { phase: unit.phase } : {}),
      ...(unit.state === 'idle' && unit.awaiting ? { awaiting: true as const } : {}),
    };
  });
}
