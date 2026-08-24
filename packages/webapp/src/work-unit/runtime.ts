/**
 * `WorkUnitRuntime` — the behavioural contract of one live unit — and the
 * host slice a {@link import('./manager.js').WorkUnitManager} needs to reach
 * them.
 *
 * Since #1666 Phase 2 the only implementation is `LiveWorkUnit`, which owns
 * its context, tab state, observer set and timers; `close()` is the single
 * teardown path. The Phase 1 read-through adapter over the orchestrator is
 * gone (#2279).
 */

import type { RegisteredScoop } from '../scoops/types.js';
import type {
  Unsubscribe,
  WorkUnitDescriptor,
  WorkUnitEventListener,
  WorkUnitId,
  WorkUnitInput,
  WorkUnitSnapshot,
} from './types.js';

/** Behavioural contract of one live unit. */
export interface WorkUnitRuntime {
  /** Fresh projection on every read — status tracks the live tab. */
  readonly descriptor: WorkUnitDescriptor;
  /** Deliver a prompt. Resolves when the turn settles (same as `sendPrompt`). */
  send(input: WorkUnitInput): Promise<void>;
  /** Subscribe to lifecycle/response events. The returned function MUST be called. */
  subscribe(listener: WorkUnitEventListener): Unsubscribe;
  /** Stop the running turn; the unit stays registered and usable. */
  abort(reason?: string): Promise<void>;
  /** Unregister and tear down. Rejects when active licks still pin the unit. */
  close(): Promise<void>;
  /** Point-in-time view of descriptor + settled history. */
  snapshot(): Promise<WorkUnitSnapshot>;
}

/**
 * The slice of the orchestrator a work-unit manager needs. Structural so
 * tests can hand in a fake and the real `Orchestrator` satisfies it
 * unchanged.
 */
export interface WorkUnitHost {
  getScoop(jid: WorkUnitId): RegisteredScoop | undefined;
  /**
   * The owning live runtime for `jid`, created if this is the first caller.
   * A unit may exist before its context (an observer subscribed ahead of
   * spawn, a boot-time error tab, a record restored but never fed).
   */
  ensureLiveUnit(jid: WorkUnitId): WorkUnitRuntime;
}
