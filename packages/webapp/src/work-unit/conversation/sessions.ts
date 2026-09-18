import type { SessionData } from '../../core/types.js';
import type { Session } from '../../scoops/chat-types.js';
import { workspaceFor } from '../descriptor.js';
import { toAgentMessages, toChatMessages } from './derive.js';
import type { WorkUnitConversationStore } from './store.js';
import type { WorkUnitConversationRecord } from './types.js';

export async function chatSessionFromRecord(record: WorkUnitConversationRecord): Promise<Session> {
  return {
    id: record.legacyKeys.chatSessionId,
    messages: await toChatMessages(record),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function agentSessionFromRecord(record: WorkUnitConversationRecord): SessionData {
  return {
    id: record.workUnitId,
    messages: toAgentMessages(record),
    config: {},
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export class CanonicalSessionReader {
  constructor(private readonly store: WorkUnitConversationStore) {}

  async loadAgentSessions(): Promise<SessionData[]> {
    return (await this.latestPerUnit()).map(agentSessionFromRecord);
  }

  async loadChatSessions(): Promise<Session[]> {
    return Promise.all((await this.latestPerUnit()).map(chatSessionFromRecord));
  }

  private async latestPerUnit(): Promise<WorkUnitConversationRecord[]> {
    const latest = new Map<string, WorkUnitConversationRecord>();
    for (const record of await this.store.loadAll()) {
      const seen = latest.get(record.workUnitId);
      if (!seen || record.updatedAt > seen.updatedAt) latest.set(record.workUnitId, record);
    }
    return [...latest.values()];
  }

  async loadRootChatSession(folder: string): Promise<Session | null> {
    const record = await this.store.loadLatestInWorkspace(
      workspaceFor({ parentJid: null, folder }).root
    );
    return record ? chatSessionFromRecord(record) : null;
  }

  async load(chatSessionId: string): Promise<Session | null> {
    const prefix = 'session-';
    if (!chatSessionId.startsWith(prefix)) return null;
    return this.loadRootChatSession(chatSessionId.slice(prefix.length));
  }
}
