import type { AgentMessage } from '../../core/index.js';
import { createLogger } from '../../core/index.js';
import type { ChatMessage } from '../../scoops/chat-types.js';
import type { RegisteredScoop } from '../../scoops/types.js';
import { chatSessionIdFor } from '../record.js';
import { entriesFromAgentMessages, entriesFromChatMessages } from './entries.js';
import { conversationKeyFor, workspaceIdFor } from './key.js';
import type { ConversationMigrationState, WorkUnitConversationStore } from './store.js';
import type { WorkUnitConversationRecord } from './types.js';
import { CONVERSATION_RECORD_VERSION } from './types.js';

const log = createLogger('work-unit-conversation');

export const CONVERSATION_MIGRATION_ID = 'conversations';

export type MigratableUnit = Pick<RegisteredScoop, 'jid' | 'folder' | 'parentJid'>;

export interface ConversationMigrationDeps {
  store: WorkUnitConversationStore;
  units: readonly MigratableUnit[];

  loadAgentSession: (
    id: string
  ) => Promise<{ messages: AgentMessage[]; createdAt?: number } | null>;

  loadChatSession: (id: string) => Promise<{ messages: ChatMessage[]; createdAt?: number } | null>;
  now?: () => number;

  onProgress?: (stage: string) => void;
}

export interface ConversationMigrationSummary {
  migrated: number;

  alreadyDone: number;

  empty: number;

  skipped: number;
}

export async function migrateConversations(
  deps: ConversationMigrationDeps
): Promise<ConversationMigrationSummary> {
  const now = deps.now ?? (() => Date.now());
  const state = await resumeState(deps.store, now());
  const summary: ConversationMigrationSummary = {
    migrated: 0,
    alreadyDone: 0,
    empty: 0,
    skipped: 0,
  };

  if (state.done) {
    summary.alreadyDone = deps.units.length;
    return summary;
  }

  const completed = new Set(state.completedKeys);
  for (const raw of deps.units) {
    const unit: MigratableUnit = { ...raw, parentJid: raw.parentJid ?? null };
    const key = conversationKeyFor(unit);
    if (completed.has(key)) {
      summary.alreadyDone++;
      continue;
    }
    try {
      const outcome = await migrateUnit(deps, unit, key, now());
      if (outcome === 'migrated') summary.migrated++;
      else if (outcome === 'already') summary.alreadyDone++;
      else summary.empty++;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      summary.skipped++;
      state.skipped.push({ key, reason });
      log.warn('Skipping a unit whose legacy conversation could not be read', {
        key,
        folder: unit.folder,
        error: reason,
      });
    }

    completed.add(key);
    state.completedKeys = [...completed];
    state.updatedAt = now();
    await deps.store.putMigrationState(state);
    deps.onProgress?.(`conversation-migrated:${unit.jid}`);
  }

  state.done = true;
  state.updatedAt = now();
  await deps.store.putMigrationState(state);
  log.info('Canonical conversation migration complete', { ...summary });
  return summary;
}

async function migrateUnit(
  deps: ConversationMigrationDeps,
  unit: MigratableUnit,
  key: string,
  now: number
): Promise<'migrated' | 'already' | 'empty'> {
  const current = await deps.store.read(key);
  if (current.status === 'ok') return 'already';
  if (current.status === 'incompatible') {
    log.info('Leaving a newer-schema conversation record untouched', {
      key,
      version: current.version,
    });
    return 'already';
  }
  if (current.status === 'error') {
    throw new Error(`canonical record unreadable: ${current.reason}`);
  }

  const identity = {
    key,
    workUnitId: unit.jid,
    workspaceId: workspaceIdFor(unit),
    folder: unit.folder,
    legacyKeys: { agentSessionId: unit.jid, chatSessionId: chatSessionIdFor(unit) },
  };

  const agentSession = await deps.loadAgentSession(unit.jid);
  if (agentSession && !Array.isArray(agentSession.messages)) {
    throw new Error('agent-sessions record has no message list');
  }
  if (agentSession && agentSession.messages.length > 0) {
    const record: WorkUnitConversationRecord = {
      ...identity,
      version: CONVERSATION_RECORD_VERSION,
      origin: 'agent-history',
      entries: entriesFromAgentMessages(agentSession.messages),
      createdAt: agentSession.createdAt ?? now,
      updatedAt: now,
      migratedFrom: 'agent-sessions',
    };
    await deps.store.save(record);
    return 'migrated';
  }

  const chatSession = await deps.loadChatSession(identity.legacyKeys.chatSessionId);
  if (chatSession && !Array.isArray(chatSession.messages)) {
    throw new Error('browser-coding-agent record has no message list');
  }
  if (chatSession && chatSession.messages.length > 0) {
    const record: WorkUnitConversationRecord = {
      ...identity,
      version: CONVERSATION_RECORD_VERSION,
      origin: 'ui-projection',
      entries: entriesFromChatMessages(chatSession.messages),
      createdAt: chatSession.createdAt ?? now,
      updatedAt: now,
      migratedFrom: 'browser-coding-agent',
    };
    await deps.store.save(record);
    return 'migrated';
  }

  return 'empty';
}

async function resumeState(
  store: WorkUnitConversationStore,
  now: number
): Promise<ConversationMigrationState> {
  const saved = await store.getMigrationState(CONVERSATION_MIGRATION_ID);
  if (saved && saved.version === CONVERSATION_RECORD_VERSION) {
    return {
      ...saved,
      completedKeys: Array.isArray(saved.completedKeys) ? saved.completedKeys : [],
      skipped: Array.isArray(saved.skipped) ? saved.skipped : [],
    };
  }
  return {
    id: CONVERSATION_MIGRATION_ID,
    version: CONVERSATION_RECORD_VERSION,
    completedKeys: [],
    skipped: [],
    done: false,
    startedAt: now,
    updatedAt: now,
  };
}
