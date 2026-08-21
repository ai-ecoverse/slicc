/**
 * `LiveWorkUnit` — the owning runtime of one unit (#1666, Phase 2).
 *
 * Phase 1 shipped an adapter that *looked at* state scattered across the
 * lifecycle manager's `tabs` / `contexts` / `scoopObservers` maps. This class
 * *owns* that state for one unit: its `ScoopContext`, its tab record, its
 * observer set and its lifecycle. `ScoopLifecycleManager` keeps a
 * `Map<jid, LiveWorkUnit>` and every map-shaped view it still exposes
 * (`getContexts()`, `getTabsMap()`) is derived from these units.
 *
 * The one thing this buys that the maps never had: `close()` is a single,
 * idempotent teardown — idle timer, running turn, context (realm workers,
 * shell processes), observers, completion buffers and waiters — so nothing
 * about a dropped unit lingers in a global map.
 *
 * The unit knows nothing about the DOM, floats, the extension, or tray
 * transports; everything external arrives through {@link LiveWorkUnitDeps}.
 */

import { createLogger } from '../base/logger.js';
import type { ScoopObserver } from '../scoops/scoop-lifecycle-manager.js';
import type { RegisteredScoop, ScoopTabState } from '../scoops/types.js';
import { toDescriptor } from './descriptor.js';
import type { WorkUnitRuntime } from './runtime.js';
import {
  statusFromTab,
  type Unsubscribe,
  type WorkUnitDescriptor,
  type WorkUnitEventListener,
  type WorkUnitId,
  type WorkUnitInput,
  type WorkUnitSnapshot,
  type WorkUnitStatus,
} from './types.js';

const log = createLogger('work-unit');

/** The slice of `ScoopContext` a unit drives. Structural so tests can stub it. */
export interface UnitContext {
  init(): Promise<void>;
  stop(): void;
  dispose(): void;
  getAgentMessages(): unknown[];
  getContextFill(): number;
}

export interface LiveWorkUnitDeps {
  /** Registry record for this unit (`undefined` once unregistered). */
  getScoop(jid: WorkUnitId): RegisteredScoop | undefined;
  /** Deliver a prompt through the host's queue-aware send path. */
  sendPrompt(
    jid: WorkUnitId,
    text: string,
    senderId: string,
    senderName: string,
    options?: { steer?: boolean }
  ): Promise<void>;
  /** Disarm the "no work received yet" notifier. */
  clearIdleTimer(jid: WorkUnitId): void;
  /** Drop response buffers / mute state and release `scoop_wait` callers. */
  forgetCompletion(jid: WorkUnitId, reason: 'close'): void;
}

/**
 * Legal tab-status transitions. Keys are the current status, values the
 * statuses it may move to. `closed` is modelled separately ({@link LiveWorkUnit.close})
 * and is terminal. An illegal transition is logged and ignored so a stale
 * callback from a disposed context can never resurrect a unit.
 */
export const LEGAL_TRANSITIONS: Readonly<
  Record<ScoopTabState['status'], ReadonlySet<ScoopTabState['status']>>
> = {
  initializing: new Set(['ready', 'error']),
  ready: new Set(['processing', 'error', 'initializing']),
  processing: new Set(['ready', 'error']),
  // `initializing` = a re-spawn after a failed init; `ready` = recovery
  // paths that re-open the same context (`routeToScoop` retry-on-error).
  error: new Set(['initializing', 'ready', 'processing']),
};

export class LiveWorkUnit implements WorkUnitRuntime {
  /** Live tab record, or `null` while no runtime has been spawned. */
  tab: ScoopTabState | null = null;
  /** Live agent context, or `null` before spawn / after close / after detach. */
  context: UnitContext | null = null;
  private readonly observers = new Set<ScoopObserver>();
  private closed = false;

  constructor(
    readonly id: WorkUnitId,
    private readonly deps: LiveWorkUnitDeps
  ) {}

  // ---------------------------------------------------------------------
  // Descriptor / status
  // ---------------------------------------------------------------------

  get descriptor(): WorkUnitDescriptor {
    const scoop = this.deps.getScoop(this.id);
    if (!scoop) throw new Error(`Work unit not found: ${this.id}`);
    const descriptor = toDescriptor(scoop, this.tab ?? undefined);
    return this.closed ? { ...descriptor, status: 'closed' } : descriptor;
  }

  get status(): WorkUnitStatus {
    return this.closed ? 'closed' : statusFromTab(this.tab?.status);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Move the tab to `next` if the transition is legal. Returns whether it
   * happened. A unit without a tab accepts any first status (it is being
   * spawned); a closed unit accepts none.
   */
  transition(next: ScoopTabState['status'], patch: Partial<ScoopTabState> = {}): boolean {
    if (this.closed) {
      log.debug('ignoring transition on closed unit', { jid: this.id, next });
      return false;
    }
    const current = this.tab?.status;
    if (current !== undefined && current !== next && !LEGAL_TRANSITIONS[current].has(next)) {
      log.warn('illegal work-unit transition ignored', { jid: this.id, from: current, to: next });
      return false;
    }
    const now = new Date().toISOString();
    this.tab = {
      jid: this.id,
      contextId: this.tab?.contextId ?? `scoop-${this.id}`,
      ...this.tab,
      ...patch,
      status: next,
      lastActivity: patch.lastActivity ?? now,
    };
    if (next !== 'error') delete this.tab.error;
    return true;
  }

  /** Record activity on the current status without changing it. */
  touch(): void {
    if (this.tab) this.tab = { ...this.tab, lastActivity: new Date().toISOString() };
  }

  // ---------------------------------------------------------------------
  // Context ownership
  // ---------------------------------------------------------------------

  /**
   * Adopt a freshly constructed context. The tab starts `initializing` under
   * `contextId`; an error tab from an earlier failed spawn is replaced.
   */
  attachContext(context: UnitContext, contextId: string): void {
    if (this.closed) throw new Error(`Cannot attach a context to closed unit ${this.id}`);
    this.context = context;
    this.tab = {
      jid: this.id,
      contextId,
      status: 'initializing',
      lastActivity: new Date().toISOString(),
    };
  }

  /**
   * Stop and forget the context WITHOUT disposing it or touching observers.
   * Used when the shared filesystem is swapped underneath every unit
   * (`resetFilesystem`): the contexts are rebuilt, the subscriptions are not.
   */
  detachContext(): void {
    this.deps.clearIdleTimer(this.id);
    this.context?.stop();
    this.context = null;
  }

  /** Dispose the context and drop the tab, keeping observers. Used by re-spawn. */
  disposeContext(): void {
    this.deps.clearIdleTimer(this.id);
    this.context?.dispose();
    this.context = null;
    this.tab = null;
  }

  // ---------------------------------------------------------------------
  // Observers
  // ---------------------------------------------------------------------

  /** Raw observer subscription (the `ScoopObserver` shape `observeScoop` exposes). */
  observe(observer: ScoopObserver): () => void {
    if (this.closed) return () => {};
    this.observers.add(observer);
    return () => {
      this.observers.delete(observer);
    };
  }

  get observerCount(): number {
    return this.observers.size;
  }

  /** Fan an observer event out; a throwing observer never breaks the others. */
  dispatch<K extends keyof ScoopObserver>(
    event: K,
    ...args: Parameters<NonNullable<ScoopObserver[K]>>
  ): void {
    for (const observer of this.observers) {
      const handler = observer[event];
      if (!handler) continue;
      try {
        (handler as (...a: unknown[]) => void)(...(args as unknown[]));
      } catch (err) {
        log.warn('scoop observer threw', {
          jid: this.id,
          event,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // ---------------------------------------------------------------------
  // WorkUnitRuntime
  // ---------------------------------------------------------------------

  send(input: WorkUnitInput): Promise<void> {
    if (this.closed) return Promise.reject(new Error(`Work unit is closed: ${this.id}`));
    const scoop = this.deps.getScoop(this.id);
    return this.deps.sendPrompt(
      this.id,
      input.text,
      input.senderId ?? 'user',
      input.senderName ?? scoop?.assistantLabel ?? this.id,
      input.steer === undefined ? undefined : { steer: input.steer }
    );
  }

  subscribe(listener: WorkUnitEventListener): Unsubscribe {
    return this.observe({
      onStatusChange: (status) => listener({ type: 'status', status: statusFromTab(status) }),
      onResponse: (text, isPartial) => listener({ type: 'response', text, isPartial }),
      onSendMessage: (text) => listener({ type: 'send-message', text }),
      onError: (error) => listener({ type: 'error', error }),
    });
  }

  async abort(_reason?: string): Promise<void> {
    this.context?.stop();
  }

  /**
   * The single teardown path. Idempotent. Order matters: disarm the idle
   * timer first (so it cannot fire into a half-torn unit), stop the turn,
   * dispose the context (realm workers + shell processes go with it), then
   * release everyone waiting on this unit.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.deps.clearIdleTimer(this.id);
    const context = this.context;
    this.context = null;
    try {
      context?.stop();
      context?.dispose();
    } catch (err) {
      log.warn('context dispose threw during close', {
        jid: this.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    this.observers.clear();
    this.deps.forgetCompletion(this.id, 'close');
    log.info('Work unit closed', { jid: this.id });
  }

  async snapshot(): Promise<WorkUnitSnapshot> {
    return {
      descriptor: this.descriptor,
      messages: this.context ? this.context.getAgentMessages() : [],
      contextFill: this.context ? this.context.getContextFill() : 0,
    };
  }
}
