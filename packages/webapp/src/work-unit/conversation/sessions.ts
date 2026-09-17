/**
 * Legacy-shaped views of canonical conversation records (#2365).
 *
 * Readers that predate #2275 consume two shapes: Pi's `SessionData`
 * (`agent-sessions`) and the chat panel's `Session` (`browser-coding-agent`).
 * Since the legacy stores stopped being written, those shapes are DERIVED
 * here from the canonical record instead — transcript export, the Freezer,
 * welcome detection and the page's pre-replay hydration all read through
 * this module, and never through a legacy store.
 */

import type { SessionData } from '../../core/types.js';
import type { Session } from '../../scoops/chat-types.js';
import { workspaceFor } from '../descriptor.js';
import { toAgentMessages, toChatMessages } from './derive.js';
import type { WorkUnitConversationStore } from './store.js';
import type { WorkUnitConversationRecord } from './types.js';

/** The chat-panel projection of a record, keyed like the legacy chat store. */
export async function chatSessionFromRecord(record: WorkUnitConversationRecord): Promise<Session> {
  return {
    id: record.legacyKeys.chatSessionId,
    messages: await toChatMessages(record),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** Pi history of a record, keyed like the legacy agent store (by jid). */
export function agentSessionFromRecord(record: WorkUnitConversationRecord): SessionData {
  return {
    id: record.workUnitId,
    messages: toAgentMessages(record),
    config: {},
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** Read-side adapter over the canonical store, in the legacy session shapes. */
export class CanonicalSessionReader {
  constructor(private readonly store: WorkUnitConversationStore) {}

  /** Every unit's Pi history — `TranscriptCollectionDeps.loadPersistedSessions`. */
  async loadAgentSessions(): Promise<SessionData[]> {
    const records = await this.store.loadAll();
    return records.map(agentSessionFromRecord);
  }

  /** Every unit's chat projection — `TranscriptCollectionDeps.loadUiChatSessions`. */
  async loadChatSessions(): Promise<Session[]> {
    const records = await this.store.loadAll();
    return Promise.all(records.map(chatSessionFromRecord));
  }

  /**
   * One ROOT unit's chat projection, by storage folder (`cone`, `cone-<slug>`).
   * `null` when the cone has no conversation. Never throws.
   */
  async loadRootChatSession(folder: string): Promise<Session | null> {
    const record = await this.store.loadLatestInWorkspace(
      workspaceFor({ parentJid: null, folder }).root
    );
    return record ? chatSessionFromRecord(record) : null;
  }

  /**
   * The same lookup keyed the way the legacy chat store was
   * (`session-<folder>`), so a caller written against that store's `load`
   * (the Freezer) reads the canonical record unchanged.
   */
  async load(chatSessionId: string): Promise<Session | null> {
    const prefix = 'session-';
    if (!chatSessionId.startsWith(prefix)) return null;
    return this.loadRootChatSession(chatSessionId.slice(prefix.length));
  }
}
