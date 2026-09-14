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

  getTurnSignal: () => AbortSignal | undefined;
  getCompactFn: () => CompactFn | null;
  getCompactionApiKey: () => string | undefined;

  isImageRecoveryActive: () => boolean;
  onResponse: (text: string, isPartial: boolean) => void;

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

  resetForRun(): void {
    this.attempted = false;
    this.active = false;
    this.pending = null;
    this.escalated = false;
  }

  get pendingRecovery(): Promise<void> | null {
    return this.pending;
  }

  clearPendingRecovery(promise: Promise<void>): void {
    if (this.pending === promise) this.pending = null;
  }

  get isActive(): boolean {
    return this.active;
  }

  get hasAttempted(): boolean {
    return this.attempted;
  }

  markSettled(): void {
    this.active = false;
  }

  markAssistantSucceeded(): void {
    this.attempted = false;
  }

  shouldRecover(message: PiAssistantMessage): boolean {
    return !this.deps.isImageRecoveryActive() && isContextOverflow(message);
  }

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
