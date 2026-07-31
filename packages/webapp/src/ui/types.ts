/**
 * Stable UI-layer import path for the agent + chat transcript contracts.
 *
 * The definitions now live at the layer that owns them — the agent contract
 * (`AgentHandle`, `AgentEvent`) in `core/agent-types.ts`, the chat transcript
 * shapes (`ChatMessage`, `ToolCall`, `MessageRole`, `LickState`) in
 * `scoops/chat-types.ts`, and `Session` in `core/session-store.ts` — so lower layers stop importing upward into
 * `ui/`. The UI keeps consuming them through this re-export.
 */

export type { AgentEvent, AgentHandle } from '../core/agent-types.js';
export type { Session } from '../core/session-store.js';
export type {
  ChatMessage,
  LickState,
  MessageRole,
  ToolCall,
} from '../scoops/chat-types.js';
