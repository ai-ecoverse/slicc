import type { ScoopSummary } from '../../scoops/tray-sync-protocol.js';
import type { RegisteredScoop } from '../../scoops/types.js';
import type { WorkUnitSummary } from '../../work-unit/client/types.js';
import { isRootUnit } from '../../work-unit/policy.js';
import { modelFor } from '../../work-unit/record.js';
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

const WIRE_ACTIVITIES: ReadonlySet<string> = new Set<WireActivity>([
  'thinking',
  'tool',
  'awaiting',
]);

function toWire(descriptor: RenderedState | undefined): Pick<ScoopSummary, 'state' | 'activity'> {
  const state = descriptor?.state ?? 'idle';
  if (state === 'working') {
    return { state, activity: descriptor?.phase === 'tool' ? 'tool' : 'thinking' };
  }
  if (state === 'idle' && descriptor?.awaiting) return { state, activity: 'awaiting' };
  return { state };
}

export function expandWireState(scoop: ScoopSummary): ExpandedState {
  const state = scoop.state ?? 'idle';
  const activity = WIRE_ACTIVITIES.has(scoop.activity ?? '') ? scoop.activity : undefined;
  if (state === 'working') return { state, phase: activity === 'tool' ? 'tool' : 'thinking' };
  if (state === 'idle' && activity === 'awaiting') return { state, awaiting: true };
  return { state };
}

export function turnsFromUnits(
  units: readonly Pick<WorkUnitSummary, 'id' | 'turns'>[]
): ReadonlyMap<string, number> {
  const turns = new Map<string, number>();
  for (const unit of units) if (typeof unit.turns === 'number') turns.set(unit.id, unit.turns);
  return turns;
}

export function toScoopSummaries(
  scoops: readonly SummarySource[],
  rendered: readonly RenderedState[],
  turns?: ReadonlyMap<string, number>
): ScoopSummary[] {
  const byJid = new Map(rendered.map((scoop) => [scoop.key, scoop]));
  return scoops.map((scoop) => {
    const descriptor = byJid.get(scoop.jid);
    const model = modelFor(scoop);
    return {
      jid: scoop.jid,
      name: scoop.name,
      folder: scoop.folder,

      isCone: isRootUnit(scoop),
      parentId: scoop.parentJid,
      assistantLabel: scoop.assistantLabel,

      ...(scoop.addedAt ? { addedAt: scoop.addedAt } : {}),
      trigger: scoop.trigger,

      ...(model ? { model } : {}),
      ...toWire(descriptor),
      fill: typeof descriptor?.fill === 'number' ? descriptor.fill : 0,

      ...(turns?.has(scoop.jid) ? { turns: turns.get(scoop.jid) } : {}),
    };
  });
}

export function summaryIsRoot(scoop: Pick<ScoopSummary, 'isCone' | 'parentId'>): boolean {
  return scoop.parentId === undefined ? scoop.isCone === true : scoop.parentId === null;
}

export function summaryRole(scoop: Pick<ScoopSummary, 'isCone' | 'parentId'>): UnitRole {
  return summaryIsRoot(scoop) ? 'cone' : 'scoop';
}

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

    ...(typeof scoop.turns === 'number' ? { turns: scoop.turns } : {}),

    ...(scoop.model ? { model: scoop.model } : {}),
    ...(scoop.trigger ? { trigger: scoop.trigger } : {}),
    ...(scoop.addedAt ? { addedAt: scoop.addedAt } : {}),
  };
}
