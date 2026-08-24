/**
 * What a terminal `agent_end` means.
 *
 * Owns: the decision tree at the end of a turn — hand a rejected image to
 * image recovery, an overflow to overflow recovery, a pre-stream failure to
 * the turn loop's deferred-error latch, and anything else to the owner — plus
 * the end-of-turn checkpoint.
 *
 * Changes when a new recoverable failure class is added, or when the order of
 * that ladder changes. It is the one place the two recovery modules and the
 * retry loop meet, and it is deliberately the ONLY place that knows the order.
 */

import type { AssistantMessage as PiAssistantMessage } from '@earendil-works/pi-ai';
import type { AgentMessage, AssistantMessage } from '../../core/index.js';
import { emitAgentError } from '../../core/telemetry-hook.js';
import { isImageProcessingError } from './error-classification.js';
import type { ImageRecovery } from './image-recovery.js';
import type { OverflowRecovery } from './overflow-recovery.js';

export interface AgentEndDeps {
  imageRecovery: ImageRecovery;
  overflow: OverflowRecovery;
  /** A turn is in flight, so a pre-stream failure belongs to the retry loop. */
  isProcessing: () => boolean;
  /** Deltas already reached the user — the error cannot be swallowed silently. */
  didStreamDeltas: () => boolean;
  /** Defer the error to the in-flight attempt instead of surfacing it now. */
  latchStreamError: (message: string) => void;
  onError: (message: string) => void;
  /** End-of-turn checkpoint; `messages` is the fallback when the agent is gone. */
  persist: (messages: AgentMessage[]) => void;
}

/** Handle agent_end error recovery and persistence. */
export function handleAgentEnd(
  messages: AgentMessage[],
  deps: AgentEndDeps,
  abortSignal?: AbortSignal
): void {
  const last = messages[messages.length - 1];
  if (last) {
    const errorMsg =
      last.role === 'assistant' ? (last as AssistantMessage).errorMessage : undefined;
    if (errorMsg) {
      if (dispatchError(errorMsg, messages, deps, abortSignal)) return;
    } else {
      deps.imageRecovery.markSettled();
      deps.overflow.markSettled();
      if (last.role === 'assistant') deps.overflow.markAssistantSucceeded();
    }
  }

  deps.persist(messages);
}

/**
 * Route a terminal assistant error. Returns true when the caller must NOT fall
 * through to the end-of-turn checkpoint — a recovery pass will drive the agent
 * further, so the history it would persist is not final.
 */
function dispatchError(
  errorMsg: string,
  messages: AgentMessage[],
  deps: AgentEndDeps,
  abortSignal?: AbortSignal
): boolean {
  const recovering = deps.imageRecovery.isActive || deps.overflow.isActive;
  if (!recovering && isImageProcessingError(errorMsg)) {
    deps.imageRecovery.recover(messages);
    return true;
  }
  if (deps.overflow.shouldRecover(messages[messages.length - 1] as PiAssistantMessage)) {
    deps.overflow.recover(messages, abortSignal);
    return true;
  }
  if (!recovering && deps.isProcessing() && !deps.didStreamDeltas()) {
    deps.latchStreamError(errorMsg);
    return true;
  }
  deps.imageRecovery.markSettled();
  deps.overflow.markSettled();
  emitAgentError('llm', errorMsg);
  deps.onError(errorMsg);
  return false;
}
