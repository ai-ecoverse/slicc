import type { ScoopSummary } from '../../scoops/tray-sync-protocol.js';
import type { RegisteredScoop } from '../../scoops/types.js';
import { scoopColor } from './wc-scoop-color.js';
import type { SwitcherScoop } from './wc-shell.js';

type SummarySource = Pick<
  RegisteredScoop,
  'jid' | 'name' | 'folder' | 'isCone' | 'parentJid' | 'assistantLabel' | 'trigger'
>;
type RenderedState = Pick<SwitcherScoop, 'key' | 'state' | 'fill' | 'phase' | 'awaiting'>;
type WireActivity = NonNullable<ScoopSummary['activity']>;
type ExpandedState = Pick<SwitcherScoop, 'state' | 'phase' | 'awaiting'>;

/**
 * This module is the ONLY place the UI's expression model (`state` + `phase` +
 * `awaiting`) and the wire's (`state` + the optional `activity` refinement)
 * convert into each other. Keeping both halves in one file is what makes them
 * auditable as a pair: the leader never re-derives what its own toolbar already
 * computed, and the follower reconstructs exactly the descriptor the leader was
 * rendering.
 *
 * The invariant that governs both: **`state` carries only the four values every
 * shipped follower already switches on.** Detail rides `activity`, which older
 * followers never read, so enriching the face cannot change how a build in the
 * wild renders the tab.
 */
const WIRE_ACTIVITIES: ReadonlySet<string> = new Set<WireActivity>([
  'thinking',
  'tool',
  'awaiting',
]);

/**
 * Collapse a rendered descriptor into the wire's `state` + `activity` pair.
 *
 * `state` is exactly what this leader sent before the expression grammar
 * existed — busy is `working`, waiting is `idle` — so an older follower sees no
 * change at all. Everything finer goes in `activity`.
 */
function toWire(descriptor: RenderedState | undefined): Pick<ScoopSummary, 'state' | 'activity'> {
  const state = descriptor?.state ?? 'idle';
  if (state === 'working') {
    return { state, activity: descriptor?.phase === 'tool' ? 'tool' : 'thinking' };
  }
  if (state === 'idle' && descriptor?.awaiting) return { state, activity: 'awaiting' };
  return { state };
}

/**
 * Expand the wire back into the descriptor fields the tabs render from.
 *
 * An `activity` this build does not recognise is IGNORED and the state alone
 * decides — the escape hatch the refinement field exists to provide, so the
 * next value added costs older followers nothing either. A busy scoop with no
 * refinement reads as thinking, which is both the tabs' own rule (a turn opens
 * in LLM-wait) and precisely what an older leader's bare `working` used to
 * render as.
 */
function fromWire(scoop: ScoopSummary): ExpandedState {
  const state = scoop.state ?? 'idle';
  const activity = WIRE_ACTIVITIES.has(scoop.activity ?? '') ? scoop.activity : undefined;
  if (state === 'working') return { state, phase: activity === 'tool' ? 'tool' : 'thinking' };
  if (state === 'idle' && activity === 'awaiting') return { state, awaiting: true };
  return { state };
}

/** Join registered scoop metadata with the leader toolbar's rendered state. */
export function toScoopSummaries(
  scoops: readonly SummarySource[],
  rendered: readonly RenderedState[]
): ScoopSummary[] {
  const byJid = new Map(rendered.map((scoop) => [scoop.key, scoop]));
  return scoops.map((scoop) => {
    const descriptor = byJid.get(scoop.jid);
    return {
      jid: scoop.jid,
      name: scoop.name,
      folder: scoop.folder,
      isCone: scoop.isCone,
      parentId: scoop.parentJid,
      assistantLabel: scoop.assistantLabel,
      trigger: scoop.trigger,
      ...toWire(descriptor),
      fill: typeof descriptor?.fill === 'number' ? descriptor.fill : 0,
    };
  });
}

/** `true` when a wire summary describes a root (cone): the edge when sent, the flag from older leaders. */
export function summaryIsRoot(scoop: Pick<ScoopSummary, 'isCone' | 'parentId'>): boolean {
  return scoop.parentId === undefined ? scoop.isCone : scoop.parentId === null;
}

/**
 * Map tray summaries onto the descriptors shared by follower and Cherry tabs.
 * Cones first (in leader order), then each cone's scoops right after it so a
 * follower with several cones reads as "cone, its scoops, next cone, …";
 * scoops whose owner is unknown (older leader) keep the leader's order.
 */
export function toFollowerSwitcherScoops(scoops: readonly ScoopSummary[]): SwitcherScoop[] {
  return orderByOwner(scoops).map((scoop) => {
    const expanded = fromWire(scoop);
    return {
      key: scoop.jid,
      type: summaryIsRoot(scoop) ? 'cone' : 'scoop',
      color: scoopColor({ isCone: summaryIsRoot(scoop), name: scoop.name }),
      label: summaryIsRoot(scoop) ? scoop.assistantLabel : scoop.name,
      eyes:
        expanded.state === 'broken' ? 'dead' : expanded.state === 'initializing' ? 'none' : 'open',
      fill: typeof scoop.fill === 'number' ? scoop.fill : 0,
      ...expanded,
    };
  });
}

/** Roots first; a scoop follows its owner when the owner is known, else keeps leader order. */
function orderByOwner(scoops: readonly ScoopSummary[]): ScoopSummary[] {
  if (!scoops.some((s) => s.parentId !== undefined)) {
    return [...scoops].sort((a, b) => Number(b.isCone) - Number(a.isCone));
  }
  const roots = scoops.filter(summaryIsRoot);
  const placed = new Set(roots.map((s) => s.jid));
  const out: ScoopSummary[] = [];
  for (const root of roots) {
    out.push(root);
    for (const s of scoops) {
      if (!placed.has(s.jid) && s.parentId === root.jid) {
        out.push(s);
        placed.add(s.jid);
      }
    }
  }
  for (const s of scoops) if (!placed.has(s.jid)) out.push(s);
  return out;
}
