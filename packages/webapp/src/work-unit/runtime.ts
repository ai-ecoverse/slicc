/**
 * `WorkUnitRuntime` — the behavioural contract of one live unit — and the
 * Phase 1 adapter that satisfies it over the existing `ScoopContext` /
 * `ScoopLifecycleManager` machinery without changing behaviour.
 *
 * The adapter does not own anything yet: every call delegates to the host
 * (the orchestrator) that still owns contexts, tabs and observers. Phase 2
 * inverts that so the runtime owns its context, tab state, observer set and
 * timers, and `close()` becomes the single teardown path.
 */

import type { ImageContent } from '../core/types.js';
import type { ScoopObserver } from '../scoops/scoop-lifecycle-manager.js';
import type { RegisteredScoop, ScoopTabState } from '../scoops/types.js';
import { toDescriptor } from './descriptor.js';
import {
  statusFromTab,
  type Unsubscribe,
  type WorkUnitDescriptor,
  type WorkUnitEventListener,
  type WorkUnitId,
  type WorkUnitInput,
  type WorkUnitSnapshot,
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
 * The slice of the orchestrator a unit adapter needs. Structural so tests
 * can hand in a fake and the real `Orchestrator` satisfies it unchanged.
 */
export interface WorkUnitHost {
  getScoop(jid: WorkUnitId): RegisteredScoop | undefined;
  getScoopTabState(jid: WorkUnitId): ScoopTabState | undefined;
  sendPrompt(
    jid: WorkUnitId,
    text: string,
    senderId: string,
    senderName: string,
    images?: ImageContent[],
    options?: { steer?: boolean }
  ): Promise<void>;
  observeScoop(jid: WorkUnitId, observer: ScoopObserver): () => void;
  stopScoop(jid: WorkUnitId): void;
  unregisterScoop(jid: WorkUnitId): Promise<void>;
  getScoopContext(jid: WorkUnitId):
    | {
        getAgentMessages(): unknown[];
        getContextFill(): number;
      }
    | undefined;
  /** The owning live runtime for `jid` when one exists (Phase 2 hosts). */
  getLiveUnit?(jid: WorkUnitId): WorkUnitRuntime | undefined;
}

/** Phase 1 adapter: a `WorkUnitRuntime` view over a registered scoop. */
export class ScoopContextWorkUnit implements WorkUnitRuntime {
  constructor(
    readonly id: WorkUnitId,
    private readonly host: WorkUnitHost
  ) {}

  private record(): RegisteredScoop {
    const scoop = this.host.getScoop(this.id);
    if (!scoop) throw new Error(`Work unit not found: ${this.id}`);
    return scoop;
  }

  get descriptor(): WorkUnitDescriptor {
    return toDescriptor(this.record(), this.host.getScoopTabState(this.id));
  }

  send(input: WorkUnitInput): Promise<void> {
    const scoop = this.record();
    return this.host.sendPrompt(
      this.id,
      input.text,
      input.senderId ?? 'user',
      input.senderName ?? scoop.assistantLabel,
      [],
      input.steer === undefined ? undefined : { steer: input.steer }
    );
  }

  subscribe(listener: WorkUnitEventListener): Unsubscribe {
    return this.host.observeScoop(this.id, {
      onStatusChange: (status) => listener({ type: 'status', status: statusFromTab(status) }),
      onResponse: (text, isPartial) => listener({ type: 'response', text, isPartial }),
      onSendMessage: (text) => listener({ type: 'send-message', text }),
      onError: (error) => listener({ type: 'error', error }),
    });
  }

  async abort(_reason?: string): Promise<void> {
    this.host.stopScoop(this.id);
  }

  close(): Promise<void> {
    return this.host.unregisterScoop(this.id);
  }

  async snapshot(): Promise<WorkUnitSnapshot> {
    const context = this.host.getScoopContext(this.id);
    return {
      descriptor: this.descriptor,
      messages: context ? context.getAgentMessages() : [],
      contextFill: context ? context.getContextFill() : 0,
    };
  }
}
