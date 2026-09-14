import type { RegisteredScoop } from '../../scoops/types.js';
import { isRootUnit } from '../policy.js';
import { modelFor } from '../record.js';
import type { WorkUnitPhase, WorkUnitPresentationState, WorkUnitSummary } from './types.js';

export interface RecordUnitState {
  status?: 'initializing' | 'ready' | 'processing' | 'error';

  fill?: number;
  phase?: WorkUnitPhase;
  awaiting?: boolean;

  turns?: number;
}

export function presentationStateFor(status: RecordUnitState['status']): WorkUnitPresentationState {
  switch (status) {
    case 'processing':
      return 'working';
    case 'error':
      return 'broken';
    case 'initializing':
      return 'initializing';
    default:
      return 'idle';
  }
}

export function recordToWorkUnitSummary(
  scoop: RegisteredScoop,
  state: RecordUnitState = {}
): WorkUnitSummary {
  const rendered = presentationStateFor(state.status);
  const model = modelFor(scoop);
  return {
    id: scoop.jid,
    parentId: scoop.parentJid,
    role: isRootUnit(scoop) ? 'primary' : 'child',
    name: scoop.name,
    folder: scoop.folder,
    assistantLabel: scoop.assistantLabel,
    state: rendered,
    ...(rendered === 'working' && state.phase ? { phase: state.phase } : {}),
    ...(rendered === 'idle' && state.awaiting ? { awaiting: true as const } : {}),

    fill: typeof state.fill === 'number' ? Math.round(state.fill * 100) : 0,

    ...(typeof state.turns === 'number' ? { turns: state.turns } : {}),
    ...(model ? { model } : {}),
    ...(scoop.trigger ? { trigger: scoop.trigger } : {}),
    ...(scoop.addedAt ? { addedAt: scoop.addedAt } : {}),
  };
}
