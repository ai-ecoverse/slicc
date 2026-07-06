/**
 * Agent-facing contract types shared by the agent core and its consumers.
 *
 * `AgentHandle` is the caller's view of a running agent (`sendMessage /
 * onEvent / stop`); `AgentEvent` is the plain discriminated union the agent
 * core emits over the wire. Both live at the `core/` layer — below the
 * kernel facade, the tray wire protocol, and the UI — so the lower layers
 * that name them no longer import upward into `ui/`.
 */

import type { MessageAttachment } from './attachments.js';

// ---------------------------------------------------------------------------
// Agent interface — a caller's view of the agent core
// ---------------------------------------------------------------------------

export interface AgentHandle {
  /** Send a user message to the agent. */
  sendMessage(text: string, messageId?: string, attachments?: MessageAttachment[]): void;
  /** Subscribe to agent events. Returns an unsubscribe function. */
  onEvent(callback: (event: AgentEvent) => void): () => void;
  /** Stop the current agent response. */
  stop(): void;
}

// ---------------------------------------------------------------------------
// Agent events — emitted by the agent core
// ---------------------------------------------------------------------------

export type AgentEvent =
  | { type: 'message_start'; messageId: string }
  | { type: 'content_delta'; messageId: string; text: string }
  | { type: 'content_done'; messageId: string }
  | { type: 'tool_use_start'; messageId: string; toolName: string; toolInput: unknown }
  | { type: 'tool_result'; messageId: string; toolName: string; result: string; isError?: boolean }
  | { type: 'tool_ui'; messageId: string; toolName: string; requestId: string; html: string }
  | { type: 'tool_ui_done'; messageId: string; requestId: string }
  | { type: 'turn_end'; messageId: string }
  | { type: 'error'; error: string }
  | { type: 'screenshot'; base64: string; url?: string }
  | { type: 'terminal_output'; text: string };
