/**
 * Agent-facing contract types shared by the agent core and its consumers.
 *
 * `AgentHandle` is the caller's view of a running agent (`sendMessage /
 * onEvent / stop`); `AgentEvent` is the plain discriminated union the agent
 * core emits over the wire. Both live at the `core/` layer — below the
 * kernel facade, the tray wire protocol, and the UI — so the lower layers
 * that name them no longer import upward into `ui/`.
 */

import type { AgentEvent, MessageAttachment } from '@slicc/shared-ts';
import type { TurnGuestGate } from '../sudo/types.js';

// AgentEvent is tray-sync wire format — canonical copy in @slicc/shared-ts;
// re-exported here so core/-layer importers keep their local import site.
export type { AgentEvent } from '@slicc/shared-ts';

// ---------------------------------------------------------------------------
// Agent interface — a caller's view of the agent core
// ---------------------------------------------------------------------------

export interface AgentHandle {
  /**
   * Send a user message to the agent. `options.steer` marks a steering send
   * (Ctrl/Cmd+Enter in the composer): when the agent is mid-turn, interrupt the
   * running turn with this message instead of queueing it behind the turn. An
   * idle agent has nothing to interrupt, so the flag is ignored there.
   */
  sendMessage(
    text: string,
    messageId?: string,
    attachments?: MessageAttachment[],
    options?: { steer?: boolean; guestGate?: TurnGuestGate }
  ): void;
  /** Subscribe to agent events. Returns an unsubscribe function. */
  onEvent(callback: (event: AgentEvent) => void): () => void;
  /** Stop the current agent response. */
  stop(): void;
}
