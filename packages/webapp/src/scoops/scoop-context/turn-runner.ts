/**
 * The prompt attempt/retry loop.
 *
 * Owns: how many times a prompt is attempted, the backoff between attempts,
 * and which of the three terminal outcomes a failure gets — stale-asset
 * reload, non-retryable fatal, or retries-exhausted.
 *
 * Changes when retry policy changes (a new ceiling, a new backoff, a new
 * class of failure that must not be retried). It deliberately knows nothing
 * about run bounds, persistence or process bookkeeping — those all happen
 * around a run, not inside it.
 */

import type { Agent, ImageContent } from '../../core/index.js';
import { createLogger } from '../../core/index.js';
import { broadcastStaleAssetReload, isDynamicImportError } from '../../core/stale-asset-channel.js';
import { emitAgentError } from '../../core/telemetry-hook.js';
import { abortableSleep, isNonRetryableError, isRetryableError } from './error-classification.js';
import type { OverflowRecovery } from './overflow-recovery.js';

const log = createLogger('scoop-context');

/** Attempts per prompt, and the first backoff step (doubled per attempt). */
export const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

export interface TurnRunnerDeps {
  isDisposed: () => boolean;
  overflow: Pick<OverflowRecovery, 'pendingRecovery' | 'clearPendingRecovery'>;
  /**
   * Reset the per-attempt stream latches (`didStreamDeltas`, the deferred
   * stream error) before an attempt starts.
   */
  beginAttempt: () => void;
  /**
   * The error an `agent_end` deferred instead of throwing — an assistant
   * message that failed before streaming a single delta. `null` when the
   * attempt really succeeded.
   */
  getStreamError: () => string | null;
  setStatus: (status: 'error') => void;
  onError: (message: string) => void;
  onFatalError?: (message: string) => void;
  /** `unit.completion.mode === 'interactive'` — a user-resubmittable turn. */
  isInteractive: boolean;
  scoopName: string;
  folder: string;
}

export class TurnRunner {
  constructor(private readonly deps: TurnRunnerDeps) {}

  /** Run agent prompt with retry loop. Returns the last error if any. */
  async run(
    agent: Agent,
    text: string,
    images: ImageContent[],
    abortSignal: AbortSignal
  ): Promise<Error | null> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      if (this.deps.isDisposed() || abortSignal.aborted) return null;

      const error = await this.tryAgentPrompt(agent, text, images, abortSignal);
      if (!error) return null;

      if (this.deps.isDisposed() || abortSignal.aborted) return null;

      lastError = error;
      const shouldReturn = await this.handleAttemptError(error, attempt, abortSignal);
      if (shouldReturn) return null;
    }

    return lastError;
  }

  /** Handle final error after retries exhausted. */
  reportExhausted(error: Error): void {
    const message = error.message;
    log.error('Agent error after retries exhausted', {
      folder: this.deps.folder,
      error: message,
      maxRetries: MAX_RETRIES,
    });
    this.fail(
      `Scoop "${this.deps.scoopName}" failed after ${MAX_RETRIES} attempts: ${message}`,
      message
    );
  }

  /** Try a single agent prompt attempt. Returns error or null on success. */
  private async tryAgentPrompt(
    agent: Agent,
    text: string,
    images: ImageContent[],
    abortSignal: AbortSignal
  ): Promise<Error | null> {
    this.deps.beginAttempt();
    try {
      await agent.prompt(text, images);
      if (this.deps.isDisposed() || abortSignal.aborted) return null;

      const recovery = this.deps.overflow.pendingRecovery;
      if (recovery !== null) {
        await recovery;
        this.deps.overflow.clearPendingRecovery(recovery);
        if (this.deps.isDisposed() || abortSignal.aborted) return null;
      }

      const streamError = this.deps.getStreamError();
      if (streamError) return new Error(streamError);
      return null;
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err));
    }
  }

  /** Handle error after a failed attempt. Returns true if should return early. */
  private async handleAttemptError(
    error: Error,
    attempt: number,
    abortSignal: AbortSignal
  ): Promise<boolean> {
    const message = error.message;

    if (this.handleStaleAssetError(message)) return true;
    if (this.handleNonRetryableError(message)) return true;

    const shouldRetry = await this.handleRetryableError(message, attempt, abortSignal);
    if (shouldRetry) return false;

    log.error('Agent error', {
      folder: this.deps.folder,
      error: message,
      attempt,
      isRetryable: isRetryableError(message),
    });

    if (attempt < MAX_RETRIES) {
      const aborted = await abortableSleep(backoffFor(attempt), abortSignal);
      if (aborted || this.deps.isDisposed()) return true;
    }

    return false;
  }

  /** Handle non-retryable error. Returns true if handled. */
  private handleNonRetryableError(message: string): boolean {
    if (!isNonRetryableError(message)) return false;

    log.error('Non-retryable agent error', {
      folder: this.deps.folder,
      error: message,
    });
    this.fail(
      `Scoop "${this.deps.scoopName}" failed with unrecoverable error: ${message}`,
      message
    );
    return true;
  }

  /**
   * Handle a stale-asset import failure (#1330). A gone content-hashed chunk
   * after a deploy — retrying the cached-failed import is futile (checked BEFORE
   * the retry matcher, which also matches "failed to fetch"), so ask the owning
   * page to reload (guarded) and surface as fatal. Returns true if handled.
   */
  handleStaleAssetError(message: string): boolean {
    if (!isDynamicImportError(message)) return false;
    log.error('Stale-asset import failure; requesting page reload', {
      folder: this.deps.folder,
      error: message,
    });
    // Only an interactive (user-facing) turn is user-resubmittable — pass
    // that so the page marks the dropped turn for one-shot auto-resubmit
    // after the recovery reload. Delegated turns broadcast (false) to reload
    // but are never replayed.
    broadcastStaleAssetReload(this.deps.isInteractive);
    this.fail(
      `Scoop "${this.deps.scoopName}" hit a stale build after a deploy; reloading to recover.`,
      message
    );
    return true;
  }

  /** Handle retryable error with exponential backoff. Returns true if should retry. */
  private async handleRetryableError(
    message: string,
    attempt: number,
    abortSignal: AbortSignal
  ): Promise<boolean> {
    if (!isRetryableError(message) || attempt >= MAX_RETRIES) return false;

    const delay = backoffFor(attempt);
    log.warn('Retryable agent error, will retry', {
      folder: this.deps.folder,
      error: message,
      attempt,
      maxRetries: MAX_RETRIES,
      delayMs: delay,
    });
    const aborted = await abortableSleep(delay, abortSignal);
    return !aborted && !this.deps.isDisposed();
  }

  /**
   * The one terminal shape all three fatal paths share: telemetry, `error`
   * status, then the fatal channel if the owner wired one — `onFatalError`
   * MUST bypass scoop_mute so the cone learns the scoop is dead.
   */
  private fail(fatalMessage: string, rawMessage: string): void {
    emitAgentError('llm', rawMessage);
    this.deps.setStatus('error');
    if (this.deps.onFatalError) {
      this.deps.onFatalError(fatalMessage);
    } else {
      this.deps.onError(rawMessage);
    }
  }
}

function backoffFor(attempt: number): number {
  return BASE_DELAY_MS * 2 ** (attempt - 1);
}

/**
 * Queue prompt if agent is busy. Returns true if queued.
 *
 * `steer` picks pi's steering queue over the follow-up queue: a steering
 * message is injected as soon as the in-flight assistant turn finishes its
 * current step, whereas a follow-up waits until the agent would otherwise
 * stop. An idle agent has nothing to interrupt, so `steer` is a no-op there
 * and the prompt runs immediately through the normal path.
 */
export function queuePromptIfBusy(
  agent: Agent,
  text: string,
  images: ImageContent[],
  opts: { steer: boolean; isProcessing: boolean; folder: string }
): boolean {
  const agentIsStreaming = agent.state?.isStreaming ?? false;
  if (opts.isProcessing || agentIsStreaming) {
    log.info(`Queueing prompt via ${opts.steer ? 'steer' : 'followUp'} while processing`, {
      folder: opts.folder,
      isProcessing: opts.isProcessing,
      agentIsStreaming,
    });
    const message = {
      role: 'user' as const,
      content: [{ type: 'text' as const, text }, ...images],
      timestamp: Date.now(),
    };
    if (opts.steer) agent.steer(message);
    else agent.followUp(message);
    return true;
  }
  return false;
}
