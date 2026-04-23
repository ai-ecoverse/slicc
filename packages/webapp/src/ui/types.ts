/**
 * Types for the Chat UI layer.
 *
 * The agent core (src/core/) is built in parallel, so we define
 * an interface contract here that both sides will converge on.
 */

import type { AuthErrorMeta } from '../providers/auth-error.js';
export type { AuthErrorMeta } from '../providers/auth-error.js';

// ---------------------------------------------------------------------------
// Agent interface — the UI's view of the agent core
// ---------------------------------------------------------------------------

export interface AgentHandle {
  /** Send a user message to the agent. */
  sendMessage(text: string, messageId?: string): void;
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
  /**
   * Agent/provider error. `authAction` is populated when the underlying
   * failure is an `AuthError` (OAuth session expired / not logged in);
   * the chat panel uses it to render an inline "Log in again" affordance
   * instead of a dead-string error bubble.
   */
  | { type: 'error'; error: string; authAction?: AuthErrorMeta }
  | { type: 'screenshot'; base64: string; url?: string }
  | { type: 'terminal_output'; text: string };

// ---------------------------------------------------------------------------
// Chat messages — stored in the UI
// ---------------------------------------------------------------------------

export type MessageRole = 'user' | 'assistant';

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: number;
  toolCalls?: ToolCall[];
  isStreaming?: boolean;
  /** Source of the message: 'cone' for main agent, scoop name for sub-agents, 'lick' for async events */
  source?: 'cone' | 'lick' | string;
  /** For licks: the channel type (webhook, cron, etc.) */
  channel?: string;
  /** True when the message is queued (submitted while the agent is still processing). */
  queued?: boolean;
  /**
   * When present, this message is an auth failure rendered with an
   * inline action affordance (e.g., a "Log in again" link that calls
   * the provider's OAuth flow). Persisted so re-opening a session
   * continues to show the link rather than a stale markdown bubble.
   */
  authAction?: AuthErrorMeta;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  result?: string;
  isError?: boolean;
  /** Transient screenshot data URL — not persisted to session store. */
  _screenshotDataUrl?: string;
}

// ---------------------------------------------------------------------------
// Session persistence
// ---------------------------------------------------------------------------

export interface Session {
  id: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}
