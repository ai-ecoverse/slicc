import type { AssistantMessage as PiAssistantMessage } from '@earendil-works/pi-ai';
import type { AgentMessage, AssistantMessage } from '../../core/index.js';
import { emitAgentError } from '../../core/telemetry-hook.js';
import { isImageProcessingError } from './error-classification.js';
import type { ImageRecovery } from './image-recovery.js';
import type { OverflowRecovery } from './overflow-recovery.js';

export interface AgentEndDeps {
  imageRecovery: ImageRecovery;
  overflow: OverflowRecovery;

  isProcessing: () => boolean;

  didStreamDeltas: () => boolean;

  latchStreamError: (message: string) => void;
  onError: (message: string) => void;

  persist: (messages: AgentMessage[]) => void;
}

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
