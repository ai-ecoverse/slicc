import type { ScoopSummary } from '../../scoops/tray-sync-protocol.js';
import type { RegisteredScoop } from '../../scoops/types.js';
import { scoopColor } from './wc-scoop-color.js';
import type { SwitcherScoop } from './wc-shell.js';

type SummarySource = Pick<
  RegisteredScoop,
  'jid' | 'name' | 'folder' | 'isCone' | 'assistantLabel' | 'trigger'
>;
type RenderedState = Pick<SwitcherScoop, 'key' | 'state' | 'fill' | 'phase' | 'awaiting'>;
type WireState = NonNullable<ScoopSummary['state']>;

/**
 * This module is the ONLY place the UI's three-field expression model
 * (`state` + `phase` + `awaiting`) and the wire's single `state` convert into
 * each other — collapsing on the way out, expanding on the way in. Keeping
 * both halves in one file is what makes them auditable as a pair: the leader
 * never re-derives what its own toolbar already computed, and the follower
 * reconstructs exactly the descriptor the leader was rendering.
 */
const WIRE_STATES: ReadonlySet<string> = new Set<WireState>([
  'working',
  'thinking',
  'awaiting',
  'broken',
  'initializing',
  'idle',
]);

/**
 * Collapse a rendered descriptor into the wire's single state. An unset phase
 * reads as `thinking`, matching the tabs' own `phaseFor`: a turn always opens
 * in LLM-wait, so "busy with no phase yet" is thinking, not a tool call.
 */
function toWireState(descriptor: RenderedState | undefined): WireState {
  const state = descriptor?.state ?? 'idle';
  if (state === 'working') return descriptor?.phase === 'tool' ? 'working' : 'thinking';
  if (state === 'idle' && descriptor?.awaiting) return 'awaiting';
  return state;
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
      assistantLabel: scoop.assistantLabel,
      trigger: scoop.trigger,
      state: toWireState(descriptor),
      fill: typeof descriptor?.fill === 'number' ? descriptor.fill : 0,
    };
  });
}

/**
 * Expand the wire's state back into the descriptor fields the tabs render
 * from, so `AgentState` stays a closed four-value union and the avatar's
 * activity derivation is character-for-character the same on leader and
 * follower.
 *
 * A state this build does not know — a leader from the future — normalizes to
 * `idle` rather than reaching the DOM as an unmatched `data-state`. That is
 * the browser's equivalent of iOS's `ScoopLifecycle` → `.unknown`, and the
 * reason neither side needed a protocol version bump.
 */
function fromWireState(
  raw: string | undefined
): Pick<SwitcherScoop, 'state' | 'phase' | 'awaiting'> {
  const wire: WireState = WIRE_STATES.has(raw ?? '') ? (raw as WireState) : 'idle';
  switch (wire) {
    case 'thinking':
      return { state: 'working', phase: 'thinking' };
    case 'working':
      return { state: 'working', phase: 'tool' };
    case 'awaiting':
      return { state: 'idle', awaiting: true };
    default:
      return { state: wire };
  }
}

/** Map tray summaries onto the descriptors shared by follower and Cherry tabs. */
export function toFollowerSwitcherScoops(scoops: readonly ScoopSummary[]): SwitcherScoop[] {
  return scoops.map((scoop) => {
    const expanded = fromWireState(scoop.state);
    return {
      key: scoop.jid,
      type: scoop.isCone ? 'cone' : 'scoop',
      color: scoopColor(scoop),
      label: scoop.isCone ? 'sliccy' : scoop.name,
      eyes:
        expanded.state === 'broken' ? 'dead' : expanded.state === 'initializing' ? 'none' : 'open',
      fill: typeof scoop.fill === 'number' ? scoop.fill : 0,
      ...expanded,
    };
  });
}
