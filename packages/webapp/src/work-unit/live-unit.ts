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

export interface UnitContext {
  init(): Promise<void>;
  stop(): void;
  dispose(): void;
  getAgentMessages(): unknown[];
  getContextFill(): number;
}

export interface LiveWorkUnitDeps {
  getScoop(jid: WorkUnitId): RegisteredScoop | undefined;

  sendPrompt(
    jid: WorkUnitId,
    text: string,
    senderId: string,
    senderName: string,
    options?: { steer?: boolean }
  ): Promise<void>;

  clearIdleTimer(jid: WorkUnitId): void;

  forgetCompletion(jid: WorkUnitId, reason: 'close'): void;

  unregister(jid: WorkUnitId): Promise<void>;
}

export const LEGAL_TRANSITIONS: Readonly<
  Record<ScoopTabState['status'], ReadonlySet<ScoopTabState['status']>>
> = {
  initializing: new Set(['ready', 'error']),
  ready: new Set(['processing', 'error', 'initializing']),
  processing: new Set(['ready', 'error']),

  error: new Set(['initializing', 'ready', 'processing']),
};

export class LiveWorkUnit implements WorkUnitRuntime {
  tab: ScoopTabState | null = null;

  context: UnitContext | null = null;
  private readonly observers = new Set<ScoopObserver>();
  private closed = false;

  constructor(
    readonly id: WorkUnitId,
    private readonly deps: LiveWorkUnitDeps
  ) {}

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

  touch(): void {
    if (this.tab) this.tab = { ...this.tab, lastActivity: new Date().toISOString() };
  }

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

  detachContext(): void {
    this.deps.clearIdleTimer(this.id);
    this.context?.stop();
    this.context = null;
  }

  disposeContext(): void {
    this.deps.clearIdleTimer(this.id);
    this.context?.dispose();
    this.context = null;
    this.tab = null;
  }

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

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.deps.unregister(this.id);
  }

  async teardown(): Promise<void> {
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
