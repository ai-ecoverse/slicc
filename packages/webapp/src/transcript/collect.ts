/**
 * Active transcript collection.
 *
 * Waits for all scoops to reach a completed-turn boundary (none processing),
 * then joins canonical agent-sessions with UI browser-coding-agent metadata
 * to build the complete input for normalization and redaction.
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { TranscriptExportError } from '@slicc/shared-ts';
import type { SessionData } from '../core/types.js';
import type { ChatMessage, Session } from '../scoops/chat-types.js';
import type { RegisteredScoop } from '../scoops/types.js';
import type { TranscriptConversationSource } from './normalize.js';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface TranscriptCollectionDeps {
  listScoops(): readonly RegisteredScoop[];
  isProcessing(jid: string): boolean;
  getAgentMessages(jid: string): readonly AgentMessage[] | null;
  loadPersistedSessions(): Promise<readonly SessionData[]>;
  loadUiChatSessions(): Promise<readonly Session[]>;
  wait(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface CollectedTranscriptInput {
  sources: TranscriptConversationSource[];
  chatMessagesByConversation: Map<string, readonly ChatMessage[]>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 50;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Compute the UI session-store ID for a given scoop. */
function uiSessionId(scoop: RegisteredScoop): string {
  return scoop.isCone ? 'session-cone' : `session-${scoop.folder}`;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Collect transcript sources from all active scoops.
 *
 * Polls every 50 ms while any scoop is processing, then loads persisted
 * sessions (fallback for live) and UI chat sessions (for attachments and
 * chatMessagesByConversation). Throws `transfer-aborted` if the signal fires.
 */
export async function collectActiveTranscriptSources(
  deps: TranscriptCollectionDeps,
  signal?: AbortSignal
): Promise<CollectedTranscriptInput> {
  const scoops = deps.listScoops();

  // Wait until every scoop has reached a completed-turn boundary.
  while (scoops.some((s) => deps.isProcessing(s.jid))) {
    if (signal?.aborted) throw new TranscriptExportError('transfer-aborted');
    await deps.wait(POLL_INTERVAL_MS, signal);
    if (signal?.aborted) throw new TranscriptExportError('transfer-aborted');
  }

  // Load both stores concurrently.
  const [persistedSessions, uiSessions] = await Promise.all([
    deps.loadPersistedSessions(),
    deps.loadUiChatSessions(),
  ]);

  // Build lookup maps.
  const persistedByJid = new Map<string, SessionData>();
  for (const session of persistedSessions) {
    persistedByJid.set(session.id, session);
  }

  const uiSessionById = new Map<string, Session>();
  for (const session of uiSessions) {
    uiSessionById.set(session.id, session);
  }

  // Assemble sources and chatMessages map in scoop order.
  const sources: TranscriptConversationSource[] = [];
  const chatMessagesByConversation = new Map<string, readonly ChatMessage[]>();

  for (const scoop of scoops) {
    // Prefer live agent messages; fall back to persisted session.
    const liveMessages = deps.getAgentMessages(scoop.jid);
    const messages: readonly AgentMessage[] =
      liveMessages ?? persistedByJid.get(scoop.jid)?.messages ?? [];

    const source: TranscriptConversationSource = {
      id: scoop.jid,
      kind: scoop.isCone ? 'cone' : 'scoop',
      name: scoop.name,
      ...(scoop.folder && !scoop.isCone ? { folder: scoop.folder } : {}),
      ...(scoop.parentJid ? { parentConversationId: scoop.parentJid } : {}),
      ...(scoop.originToolCallId ? { originToolCallId: scoop.originToolCallId } : {}),
      messages,
    };
    sources.push(source);

    // Map UI session messages to this JID.
    const sid = uiSessionId(scoop);
    const uiSession = uiSessionById.get(sid);
    if (uiSession) {
      chatMessagesByConversation.set(scoop.jid, uiSession.messages);
    }
  }

  return { sources, chatMessagesByConversation };
}
