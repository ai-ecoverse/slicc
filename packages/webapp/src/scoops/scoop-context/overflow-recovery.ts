/**
 * Context-window overflow recovery.
 *
 * Owns: the four flags that make overflow recovery run at most once per run
 * (`attempted` / `active` / `escalated`) plus the in-flight recovery promise
 * a turn has to await, the forced compaction, the resume, and the escalation
 * message when compaction cannot reduce the context.
 *
 * Changes when compaction changes, or when the recovery ladder gains a rung.
 * It is the one cluster whose whole point is a small state machine, and it was
 * previously indistinguishable from the turn loop it interleaves with.
 */

import type { AssistantMessage as PiAssistantMessage } from '@earendil-works/pi-ai';
import { isContextOverflow } from '@earendil-works/pi-ai/compat';
import { type createCompactContext, hasCompactionProgress } from '../../core/context-compaction.js';
import type { AgentMessage } from '../../core/index.js';
import { type Agent, createLogger } from '../../core/index.js';

const log = createLogger('scoop-context');

export type CompactFn = ReturnType<typeof createCompactContext>;

export interface OverflowRecoveryDeps {
  getAgent: () => Agent | null;
  isDisposed: () => boolean;
  /** The in-flight turn's abort signal, merged with the event's. */
  getTurnSignal: () => AbortSignal | undefined;
  getCompactFn: () => CompactFn | null;
  getCompactionApiKey: () => string | undefined;
  /** True while image recovery holds the agent — overflow must not interleave. */
  isImageRecoveryActive: () => boolean;
  onResponse: (text: string, isPartial: boolean) => void;
  /** Escalation sink: `onError` for an interactive unit, `onFatalError` otherwise. */
  onExhausted: (message: string) => void;
  setStatus: (status: 'error') => void;
  scoopName: string;
  folder: string;
}

export class OverflowRecovery {
  private attempted = false;
  private active = false;
  private escalated = false;
  private pending: Promise<void> | null = null;

  constructor(private readonly deps: OverflowRecoveryDeps) {}

  /** Clear all recovery state at the start of a prompt run. */
  resetForRun(): void {
    this.attempted = false;
    this.active = false;
    this.pending = null;
    this.escalated = false;
  }

  /** A recovery a turn must await before deciding the attempt failed. */
  get pendingRecovery(): Promise<void> | null {
    return this.pending;
  }

  /** Drop `promise` if it is still the pending one (it may have been replaced). */
  clearPendingRecovery(promise: Promise<void>): void {
    if (this.pending === promise) this.pending = null;
  }

  get isActive(): boolean {
    return this.active;
  }

  /** Whether this run already spent its one forced-compaction attempt. */
  get hasAttempted(): boolean {
    return this.attempted;
  }

  /** A terminal `agent_end` settles any recovery that was in flight. */
  markSettled(): void {
    this.active = false;
  }

  /** A clean assistant message re-arms the one-shot compaction attempt. */
  markAssistantSucceeded(): void {
    this.attempted = false;
  }

  shouldRecover(message: PiAssistantMessage): boolean {
    return !this.deps.isImageRecoveryActive() && isContextOverflow(message);
  }

  /** Compact once after an overflow, then resume only after the active run settles. */
  recover(messages: AgentMessage[], abortSignal?: AbortSignal): void {
    const turnSignal = this.deps.getTurnSignal();
    const signal =
      abortSignal && turnSignal
        ? AbortSignal.any([abortSignal, turnSignal])
        : (abortSignal ?? turnSignal);
    const agent = this.deps.getAgent();
    if (!agent || this.deps.isDisposed() || signal?.aborted) return;

    if (this.attempted) {
      this.escalate(signal);
      return;
    }
    this.attempted = true;
    this.active = true;

    log.warn('Context overflow detected, attempting recovery', {
      folder: this.deps.folder,
      messageCount: messages.length,
    });

    const compactFn = this.deps.getCompactFn();
    const history = agent.state.messages;
    const last = history[history.length - 1];
    const messagesWithoutOverflow =
      last?.role === 'assistant' && isContextOverflow(last as PiAssistantMessage)
        ? history.slice(0, -1)
        : history;
    agent.state.messages = messagesWithoutOverflow;

    if (!compactFn || !agent.state.model || !this.deps.getCompactionApiKey()) {
      this.escalate(signal, new Error('Compaction is unavailable'));
      return;
    }

    this.pending = this.compactAndResume(agent, compactFn, messagesWithoutOverflow, signal);
  }

  private async compactAndResume(
    agent: Agent,
    compactFn: CompactFn,
    messages: AgentMessage[],
    abortSignal?: AbortSignal
  ): Promise<void> {
    try {
      const compacted = await compactFn(messages, abortSignal, { force: true });
      if (this.deps.isDisposed() || abortSignal?.aborted || this.deps.getAgent() !== agent) return;
      if (!hasCompactionProgress(messages, compacted)) {
        this.escalate(abortSignal, new Error('Forced compaction did not reduce the context'));
        return;
      }
      agent.state.messages = compacted;
      this.deps.onResponse('Context window exceeded — compacting history and continuing...', false);

      await new Promise<void>((resolve) => {
        setTimeout(() => {
          if (this.deps.isDisposed() || abortSignal?.aborted || this.deps.getAgent() !== agent) {
            resolve();
            return;
          }
          agent
            .continue()
            .then(resolve)
            .catch((err) => {
              if (!this.deps.isDisposed() && !abortSignal?.aborted) {
                this.escalate(abortSignal, err);
              }
              resolve();
            });
        }, 100);
      });
    } catch (err) {
      if (!this.deps.isDisposed() && !abortSignal?.aborted) {
        this.escalate(abortSignal, err);
      }
    } finally {
      this.active = false;
    }
  }

  private escalate(abortSignal?: AbortSignal, cause?: unknown): void {
    this.active = false;
    if (this.deps.isDisposed() || abortSignal?.aborted || this.escalated) return;
    this.escalated = true;
    const causeMessage = cause instanceof Error ? cause.message : cause ? String(cause) : undefined;
    log.error('Context overflow recovery exhausted', {
      folder: this.deps.folder,
      error: causeMessage,
    });
    this.deps.setStatus('error');
    this.deps.onExhausted(
      `Scoop "${this.deps.scoopName}" context window was exceeded and could not be reduced. Re-delegate with a narrower task.`
    );
  }
}
