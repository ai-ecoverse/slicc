import type { AgentEvent, MessageAttachment } from '@slicc/shared-ts';
import type { TurnGuestGate } from '../sudo/types.js';

export type { AgentEvent } from '@slicc/shared-ts';

export interface AgentHandle {
  sendMessage(
    text: string,
    messageId?: string,
    attachments?: MessageAttachment[],
    options?: { steer?: boolean; guestGate?: TurnGuestGate }
  ): void;

  onEvent(callback: (event: AgentEvent) => void): () => void;

  stop(): void;
}
