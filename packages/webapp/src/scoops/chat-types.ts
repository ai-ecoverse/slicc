/**
 * Chat transcript shapes — the persisted chat / session record vocabulary.
 *
 * These types describe the transcript the chat panel renders and the session
 * store persists (`ChatMessage`, `ToolCall`, `Session`), plus the small
 * enums they carry (`MessageRole`, `LickState`). They sit at the `scoops/`
 * layer alongside the transcript producers (`agent-message-to-chat.ts`), the
 * tray wire protocol (`tray-sync-protocol.ts`), and the transcript caps, so
 * those consumers no longer import upward into `ui/`.
 */

import type { MessageAttachment } from '../core/attachments.js';

export type MessageRole = 'user' | 'assistant';

/**
 * Result state of an actionable lick card (currently scoop sudo-requests):
 * `pending` (awaiting a decision — the default), `confirmed` (allowed), or
 * `dismissed` (denied). Drives the `<slicc-lick-card>` `state` attribute.
 */
export type LickState = 'pending' | 'confirmed' | 'dismissed';

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: number;
  attachments?: MessageAttachment[];
  toolCalls?: ToolCall[];
  isStreaming?: boolean;
  /** Source of the message: 'cone' for main agent, scoop name for sub-agents, 'lick' for async events */
  source?: 'cone' | 'lick' | string;
  /** For licks: the channel type (webhook, cron, etc.) */
  channel?: string;
  /** Render-time collation: how many consecutive same-channel licks this row stands for. */
  lickCount?: number;
  /** Render-time collation: the individual lick bodies folded into this row. */
  lickParts?: string[];
  /**
   * For actionable licks (sudo-request): the orchestrator-minted lick id used
   * to locate this card when its decision settles, so the state can flip live.
   */
  lickId?: string;
  /** Result state for an actionable lick: pending / confirmed / dismissed. */
  lickState?: LickState;
  /** True when the message is queued (submitted while the agent is still processing). */
  queued?: boolean;
  /**
   * Cone-error marker — set by the chat controller's `error` AgentEvent
   * handler. The view renders this assistant message as a `slicc-error-card`
   * with a retry affordance instead of a plain assistant bubble.
   */
  error?: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  result?: string;
  isError?: boolean;
  /** Transient screenshot data URL — not persisted to session store. */
  _screenshotDataUrl?: string;
  /** Transient tool-UI request id used by `handleToolUI` to thread the
   *  approval/result roundtrip back to the offscreen agent. Not
   *  persisted. */
  _toolUIRequestId?: string;
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
