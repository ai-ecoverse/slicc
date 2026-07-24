/**
 * Active transcript collection.
 *
 * Waits for all scoops to reach a stable completed-turn boundary — none
 * processing — then loads persisted and UI chat sessions concurrently.
 * After loading, it verifies that the snapshot is still stable: same scoop
 * membership and processing states as before the load. If the state changed
 * during the async I/O (e.g. a new scoop joined or an agent resumed), the
 * whole cycle retries. This ensures no mid-turn document is ever returned as
 * "complete". The retry is signal-aware and does not add a global lock.
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

/**
 * Compute a stable string signature of the current scoop list, processing
 * states, and live message generation. Two signatures are equal iff the scoop
 * membership, per-scoop processing flags, and per-scoop live message state
 * (count, last-message role, last-message timestamp, last-message toolCallId)
 * are all identical. Used to detect mid-load state changes, including a
 * complete turn that starts and finishes while stores are loading.
 */
function computeSnapshotSignature(
  scoops: readonly RegisteredScoop[],
  deps: TranscriptCollectionDeps
): string {
  return scoops
    .map((s) => {
      const proc = deps.isProcessing(s.jid) ? '1' : '0';
      const msgs = deps.getAgentMessages(s.jid);
      if (msgs === null) return `${s.jid}:${proc}:null`;
      const count = msgs.length;
      const last = msgs[count - 1];
      const lastRole = last?.role ?? '';
      const lastTs = last && 'timestamp' in last ? (last.timestamp as number) : -1;
      const lastTcid = last && 'toolCallId' in last ? (last.toolCallId as string) : '';
      return `${s.jid}:${proc}:${count}:${lastRole}:${lastTs}:${lastTcid}`;
    })
    .join(',');
}

/**
 * Assemble the result from stable scoop + store data.
 */
function assembleResult(
  scoops: readonly RegisteredScoop[],
  persistedSessions: readonly SessionData[],
  uiSessions: readonly Session[],
  deps: TranscriptCollectionDeps
): CollectedTranscriptInput {
  const persistedByJid = new Map<string, SessionData>();
  for (const session of persistedSessions) {
    persistedByJid.set(session.id, session);
  }

  const uiSessionById = new Map<string, Session>();
  for (const session of uiSessions) {
    uiSessionById.set(session.id, session);
  }

  const sources: TranscriptConversationSource[] = [];
  const chatMessagesByConversation = new Map<string, readonly ChatMessage[]>();

  for (const scoop of scoops) {
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

    const sid = uiSessionId(scoop);
    const uiSession = uiSessionById.get(sid);
    if (uiSession) {
      chatMessagesByConversation.set(scoop.jid, uiSession.messages);
    }
  }

  return { sources, chatMessagesByConversation };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Collect transcript sources from all active scoops.
 *
 * Polls every 50 ms while any scoop is processing, then loads persisted
 * sessions (fallback for live) and UI chat sessions (for attachments and
 * chatMessagesByConversation) concurrently. After loading, verifies that the
 * scoop membership and processing states did not change during the async I/O.
 * If they changed, retries the whole cycle. Throws `transfer-aborted` if the
 * signal fires.
 *
 * This prevents returning a mid-turn snapshot: no scoop may start (or stop)
 * processing between the stability check and the store reads completing.
 */
export async function collectActiveTranscriptSources(
  deps: TranscriptCollectionDeps,
  signal?: AbortSignal
): Promise<CollectedTranscriptInput> {
  // Retry until a stable completed-turn boundary is confirmed, or signal fires.
  // Each iteration: poll → snapshot → load → verify. If the snapshot changed
  // during the load, the next iteration re-polls from a fresh scoop list.
  while (true) {
    const scoops = deps.listScoops();

    // Poll until every scoop has reached a completed-turn boundary.
    while (scoops.some((s) => deps.isProcessing(s.jid))) {
      if (signal?.aborted) throw new TranscriptExportError('transfer-aborted');
      await deps.wait(POLL_INTERVAL_MS, signal);
      if (signal?.aborted) throw new TranscriptExportError('transfer-aborted');
    }

    // Capture snapshot signature before the async store reads.
    const signatureBefore = computeSnapshotSignature(scoops, deps);

    // Load both stores concurrently.
    const [persistedSessions, uiSessions] = await Promise.all([
      deps.loadPersistedSessions(),
      deps.loadUiChatSessions(),
    ]);

    if (signal?.aborted) throw new TranscriptExportError('transfer-aborted');

    // Re-read scoop list and processing states; verify they match the pre-load snapshot.
    // If any scoop joined, left, or changed processing state during the load, retry.
    const afterScoops = deps.listScoops();
    const signatureAfter = computeSnapshotSignature(afterScoops, deps);

    if (signatureBefore === signatureAfter) {
      // Stable boundary confirmed — assemble and return.
      return assembleResult(afterScoops, persistedSessions, uiSessions, deps);
    }
    // State changed during load — retry from the top.
  }
}
