import type { ScoopSummary } from '../../scoops/tray-sync-protocol.js';
import type { RegisteredScoop } from '../../scoops/types.js';
import { scoopColor } from './wc-scoop-color.js';
import type { SwitcherScoop } from './wc-shell.js';

type SummarySource = Pick<
  RegisteredScoop,
  'jid' | 'name' | 'folder' | 'isCone' | 'assistantLabel' | 'trigger'
>;
type RenderedState = Pick<SwitcherScoop, 'key' | 'state' | 'fill'>;

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
      state: descriptor?.state ?? 'idle',
      fill: typeof descriptor?.fill === 'number' ? descriptor.fill : 0,
    };
  });
}

/** Map tray summaries onto the descriptors shared by follower and Cherry tabs. */
export function toFollowerSwitcherScoops(scoops: readonly ScoopSummary[]): SwitcherScoop[] {
  return scoops.map((scoop) => {
    const state = scoop.state ?? 'idle';
    return {
      key: scoop.jid,
      type: scoop.isCone ? 'cone' : 'scoop',
      color: scoopColor(scoop),
      label: scoop.isCone ? 'sliccy' : scoop.name,
      eyes: state === 'broken' ? 'dead' : state === 'initializing' ? 'none' : 'open',
      state,
      fill: typeof scoop.fill === 'number' ? scoop.fill : 0,
    };
  });
}
