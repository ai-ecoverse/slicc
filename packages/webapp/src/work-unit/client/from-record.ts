/**
 * Registered record → {@link WorkUnitSummary} (#2274).
 *
 * The leader's half of the protocol projection. It lives here rather than in
 * the adapter so the tab strip and `LocalWorkUnitClient` cannot answer
 * differently for the same unit — that divergence is the whole reason this
 * protocol exists.
 */

import type { RegisteredScoop } from '../../scoops/types.js';
import { isRootUnit } from '../policy.js';
import { modelFor } from '../record.js';
import type { WorkUnitPhase, WorkUnitPresentationState, WorkUnitSummary } from './types.js';

/** Runtime state the page keeps for a unit; the record itself carries none. */
export interface RecordUnitState {
  /** `ScoopTabState['status']` as the page tracks it. */
  status?: 'initializing' | 'ready' | 'processing' | 'error';
  /** 0–1 share of the context window, as the kernel reports it. */
  fill?: number;
  phase?: WorkUnitPhase;
  awaiting?: boolean;
}

/** Map the page's status vocabulary onto the protocol's rendered state. */
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

/**
 * Project one record plus its page-side state onto the protocol.
 *
 * `parentId` is always known locally — the edge has been required on the
 * record since #1666 phase 1 — so the protocol's `undefined` ("owner
 * unknown", a leader too old to send it) never occurs on this side.
 * Refinements are gated on the state they refine, so a stale phase left in a
 * page map cannot put a tool pin on an idle tab.
 */
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
    // The kernel reports a 0–1 ratio; the protocol (and both strips) speak percent.
    fill: typeof state.fill === 'number' ? Math.round(state.fill * 100) : 0,
    ...(model ? { model } : {}),
    ...(scoop.trigger ? { trigger: scoop.trigger } : {}),
    ...(scoop.addedAt ? { addedAt: scoop.addedAt } : {}),
  };
}
