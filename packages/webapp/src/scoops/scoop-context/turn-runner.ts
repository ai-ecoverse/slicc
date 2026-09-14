import type { Agent, ImageContent } from '../../core/index.js';
import { createLogger } from '../../core/index.js';
import { broadcastStaleAssetReload, isDynamicImportError } from '../../core/stale-asset-channel.js';
import { emitAgentError } from '../../core/telemetry-hook.js';
import { abortableSleep, isNonRetryableError, isRetryableError } from './error-classification.js';
import type { OverflowRecovery } from './overflow-recovery.js';

const log = createLogger('scoop-context');

export const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

export interface TurnRunnerDeps {
  isDisposed: () => boolean;
  overflow: Pick<OverflowRecovery, 'pendingRecovery' | 'clearPendingRecovery'>;

  beginAttempt: () => void;

  getStreamError: () => string | null;
  setStatus: (status: 'error') => void;
  onError: (message: string) => void;
  onFatalError?: (message: string) => void;

  isInteractive: boolean;
  scoopName: string;
  folder: string;
}

export class TurnRunner {
  constructor(private readonly deps: TurnRunnerDeps) {}

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

  handleStaleAssetError(message: string): boolean {
    if (!isDynamicImportError(message)) return false;
    log.error('Stale-asset import failure; requesting page reload', {
      folder: this.deps.folder,
      error: message,
    });

    broadcastStaleAssetReload(this.deps.isInteractive);
    this.fail(
      `Scoop "${this.deps.scoopName}" hit a stale build after a deploy; reloading to recover.`,
      message
    );
    return true;
  }

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
