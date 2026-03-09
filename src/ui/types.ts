/**
 * Types for the Chat UI layer.
 *
 * The agent core (src/core/) is built in parallel, so we define
 * an interface contract here that both sides will converge on.
 */

// ---------------------------------------------------------------------------
// Agent interface — the UI's view of the agent core
// ---------------------------------------------------------------------------

export interface AgentHandle {
  /** Send a user message to the agent. */
  sendMessage(text: string): void;
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
  | { type: 'turn_end'; messageId: string }
  | { type: 'error'; error: string }
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
