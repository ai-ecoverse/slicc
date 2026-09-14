import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { TranscriptExportError } from '@slicc/shared-ts';
import type { SessionData } from '../core/types.js';
import type { ChatMessage, Session } from '../scoops/chat-types.js';
import type { RegisteredScoop } from '../scoops/types.js';
import { isRootUnit, subtreeOf } from '../work-unit/policy.js';
import { chatSessionIdFor } from '../work-unit/record.js';
import type { TranscriptConversationSource } from './normalize.js';

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

export interface TranscriptCollectionScope {
  rootJid?: string;
}

const POLL_INTERVAL_MS = 50;

function uiSessionId(scoop: RegisteredScoop): string {
  return chatSessionIdFor(scoop);
}

export { subtreeOf } from '../work-unit/policy.js';

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
      kind: isRootUnit(scoop) ? 'cone' : 'scoop',
      name: scoop.name,
      ...(scoop.folder && !isRootUnit(scoop) ? { folder: scoop.folder } : {}),
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

export async function collectActiveTranscriptSources(
  deps: TranscriptCollectionDeps,
  signal?: AbortSignal,
  scope: TranscriptCollectionScope = {}
): Promise<CollectedTranscriptInput> {
  const inScope = (all: readonly RegisteredScoop[]): readonly RegisteredScoop[] =>
    scope.rootJid === undefined ? all : subtreeOf(all, scope.rootJid);

  while (true) {
    const scoops = inScope(deps.listScoops());

    while (scoops.some((s) => deps.isProcessing(s.jid))) {
      if (signal?.aborted) throw new TranscriptExportError('transfer-aborted');
      await deps.wait(POLL_INTERVAL_MS, signal);
      if (signal?.aborted) throw new TranscriptExportError('transfer-aborted');
    }

    const signatureBefore = computeSnapshotSignature(scoops, deps);

    const [persistedSessions, uiSessions] = await Promise.all([
      deps.loadPersistedSessions(),
      deps.loadUiChatSessions(),
    ]);

    if (signal?.aborted) throw new TranscriptExportError('transfer-aborted');

    const afterScoops = inScope(deps.listScoops());
    const signatureAfter = computeSnapshotSignature(afterScoops, deps);

    if (signatureBefore === signatureAfter) {
      return assembleResult(afterScoops, persistedSessions, uiSessions, deps);
    }
  }
}
