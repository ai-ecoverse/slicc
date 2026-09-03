import type { ScoopSummary } from '../../scoops/tray-sync-protocol.js';
import type { RegisteredScoop } from '../../scoops/types.js';
import { toTabDescriptors } from '../../work-unit/client/presentation.js';
import type { WorkUnitSummary } from '../../work-unit/client/types.js';
import { isRootUnit } from '../../work-unit/policy.js';
import { modelFor } from '../../work-unit/record.js';
import { scoopColor } from './wc-scoop-color.js';
import type { SwitcherScoop } from './wc-shell.js';
import type { UnitRole } from './wc-unit-context.js';

type SummarySource = Pick<
  RegisteredScoop,
  'jid' | 'name' | 'folder' | 'parentJid' | 'assistantLabel' | 'trigger' | 'model' | 'config'
> &
  Partial<Pick<RegisteredScoop, 'addedAt'>>;
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
 * Exported because `RemoteWorkUnitClient` projects the same expansion onto
 * the client protocol (#2274) — the pair with {@link toWire} stays here so
 * the two halves of the grammar remain auditable together.
 *
 * An `activity` this build does not recognise is IGNORED and the state alone
 * decides — the escape hatch the refinement field exists to provide, so the
 * next value added costs older followers nothing either. A busy scoop with no
 * refinement reads as thinking, which is both the tabs' own rule (a turn opens
 * in LLM-wait) and precisely what an older leader's bare `working` used to
 * render as.
 */
export function expandWireState(scoop: ScoopSummary): ExpandedState {
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
    const model = modelFor(scoop);
    return {
      jid: scoop.jid,
      name: scoop.name,
      folder: scoop.folder,
      // The wire keeps `isCone` for followers below protocol version 8; it is
      // projected from the ownership edge, never read off the record (#2279).
      // `BroadcastManager` strips it again per peer (#2358 stage 2).
      isCone: isRootUnit(scoop),
      parentId: scoop.parentJid,
      assistantLabel: scoop.assistantLabel,
      // Strip ordering input, so a follower orders cones the way the leader
      // does rather than by wire position (#2274).
      ...(scoop.addedAt ? { addedAt: scoop.addedAt } : {}),
      trigger: scoop.trigger,
      // Per-unit model (#2310) — a follower shows the model of the cone it is
      // looking at, not one global setting. Omitted for a record that has
      // none yet, which older followers ignore anyway.
      ...(model ? { model } : {}),
      ...toWire(descriptor),
      fill: typeof descriptor?.fill === 'number' ? descriptor.fill : 0,
    };
  });
}

/**
 * `true` when a wire summary describes a root (cone).
 *
 * The ownership edge decides wherever the leader sends it: `null` is a root,
 * a jid is owned. An ABSENT edge falls back to the deprecated `isCone` flag,
 * and only that case does — the exact mirror of the Swift rule
 * (`ScoopSummary.isRootUnit`, `parentId == nil && (isCone ?? true)`), so the
 * two follower families never disagree about the same payload.
 *
 * The fallback is not hypothetical: a hosted leader tab opened before
 * `parentId` landed and never reloaded still sends `{ isCone }` alone. Without
 * it such a roster has ZERO roots, every unit reads as owned, and the follower
 * composer unmounts silently while iOS on the same bytes still finds its cone.
 *
 * **This is the last `.isCone` read in TypeScript.** Stage 3 of
 * [#2358](https://github.com/ai-ecoverse/slicc/issues/2358) deletes the
 * fallback and the wire field together.
 */
export function summaryIsRoot(scoop: Pick<ScoopSummary, 'isCone' | 'parentId'>): boolean {
  return scoop.parentId === undefined ? scoop.isCone === true : scoop.parentId === null;
}

/** The switcher descriptor's role for a wire summary — the follower's half of `unitRoleFor`. */
export function summaryRole(scoop: Pick<ScoopSummary, 'isCone' | 'parentId'>): UnitRole {
  return summaryIsRoot(scoop) ? 'cone' : 'scoop';
}

/**
 * Project one wire summary onto the client protocol (#2274).
 *
 * `parentId` stays possibly-`undefined` on purpose: a leader that omits the
 * edge leaves the owner UNKNOWN, and inventing one would turn a scoop into a
 * root. `role` still answers what the unit is, through `summaryIsRoot` — which
 * for that one case reads the deprecated `isCone` flag the same leader does
 * send.
 */
export function summaryToWorkUnit(scoop: ScoopSummary): WorkUnitSummary {
  const expanded = expandWireState(scoop);
  return {
    id: scoop.jid,
    parentId: scoop.parentId,
    role: summaryIsRoot(scoop) ? 'primary' : 'child',
    name: scoop.name,
    folder: scoop.folder,
    assistantLabel: scoop.assistantLabel,
    state: expanded.state ?? 'idle',
    ...(expanded.phase ? { phase: expanded.phase } : {}),
    ...(expanded.awaiting ? { awaiting: true as const } : {}),
    fill: typeof scoop.fill === 'number' ? scoop.fill : 0,
    // Absent means "not known yet", never "the global selection": an empty
    // catalog is warm-up, not an answer (#2329), so a reader must not latch.
    ...(scoop.model ? { model: scoop.model } : {}),
    ...(scoop.trigger ? { trigger: scoop.trigger } : {}),
    ...(scoop.addedAt ? { addedAt: scoop.addedAt } : {}),
  };
}

/**
 * Map tray summaries onto the descriptors shared by follower and Cherry tabs.
 *
 * Ordering and rendering both live in `work-unit/client/presentation.ts`
 * since #2274 — this is the wire's half of the projection and nothing more.
 * The leader's strip goes through the same two functions from its own
 * records, which is what stops the two from drifting again (#2317).
 */
export function toFollowerSwitcherScoops(
  scoops: readonly ScoopSummary[],
  selectedJid?: string | null
): SwitcherScoop[] {
  return toTabDescriptors(scoops.map(summaryToWorkUnit), selectedJid, scoopColor);
}
