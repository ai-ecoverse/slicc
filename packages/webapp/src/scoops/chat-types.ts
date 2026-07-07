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

import type { ChatMessage } from '@slicc/shared-ts';

// Transcript wire types moved to @slicc/shared-ts (tray sync protocol
// payloads); re-exported here so scoops/-layer importers keep their local
// import site. `Session` below is session-store persistence, not wire.
export type { ChatMessage, LickState, MessageRole, ToolCall } from '@slicc/shared-ts';

// ---------------------------------------------------------------------------
// Session persistence
// ---------------------------------------------------------------------------

export interface Session {
  id: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}
