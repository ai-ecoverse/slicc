/**
 * Versioned, resumable migration of the legacy conversation stores into the
 * canonical one (#2275).
 *
 * The rules this pass is built around, in order of importance:
 *
 * 1. **Nothing is ever deleted.** The legacy stores are left byte-for-byte
 *    as they were. This is a read-old/write-new window, not a cutover: for
 *    as long as it is open, every turn still writes `agent-sessions` and
 *    `browser-coding-agent`, so clearing the canonical database is a
 *    complete rollback (`WorkUnitConversationStore.clearAll`).
 * 2. **One unit cannot break the boot.** Every unit is migrated inside its
 *    own try/catch; a legacy record that will not read is recorded in
 *    `skipped` with its reason and left in place for a later build to
 *    repair. The unit simply keeps reading the legacy stores.
 * 3. **It resumes.** The cursor is persisted after every unit, so a boot
 *    that dies mid-pass — a poisoned record, a killed tab, the #2006
 *    ready-timeout — continues where it stopped instead of starting over.
 * 4. **It is versioned.** `CONVERSATION_RECORD_VERSION` is part of the
 *    cursor; bumping the record schema re-runs the pass over every unit.
 *
 * Source precedence per unit: Pi history (`agent-sessions`, keyed by jid)
 * first, because it is the only faithful input for a Pi restore; the chat
 * projection (`browser-coding-agent`, keyed `session-<folder>`) only when
 * there is no Pi history at all.
 */

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

/** Cursor id. One pass, versioned by the record schema. */
export const CONVERSATION_MIGRATION_ID = 'conversations';

/** The unit fields the migration needs — a `RegisteredScoop` satisfies it. */
export type MigratableUnit = Pick<RegisteredScoop, 'jid' | 'folder' | 'parentJid'>;

export interface ConversationMigrationDeps {
  store: WorkUnitConversationStore;
  units: readonly MigratableUnit[];
  /** `agent-sessions` read, by jid. May reject; the unit is then skipped. */
  loadAgentSession: (
    id: string
  ) => Promise<{ messages: AgentMessage[]; createdAt?: number } | null>;
  /** `browser-coding-agent` read, by `session-<folder>`. */
  loadChatSession: (id: string) => Promise<{ messages: ChatMessage[]; createdAt?: number } | null>;
  now?: () => number;
}

export interface ConversationMigrationSummary {
  /** Units that gained a canonical record in THIS pass. */
  migrated: number;
  /** Units already migrated (a resumed pass, or a second boot). */
  alreadyDone: number;
  /** Units with no conversation anywhere — nothing to write. */
  empty: number;
  /** Units whose legacy data could not be read; left untouched. */
  skipped: number;
}

/**
 * Run (or resume) the pass. Safe to call on every boot: a completed pass at
 * the current version returns immediately.
 */
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
    // A record saved before the ownership edge (#1666) carries no
    // `parentJid` at all, and `isRootUnit` is deliberately a strict
    // `=== null` test — so an un-backfilled record would key as a CHILD and
    // land under `/scoops/<folder>/workspace`. Boot backfills before this
    // pass runs (`Orchestrator.init`); coercing here keeps any other caller
    // honest without loosening the root test the compiler enforces.
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
    // The cursor advances for a skipped unit too: retrying an unreadable
    // record on every boot would re-spend the boot budget that made it
    // unreadable. A schema bump re-runs the whole pass, which is the
    // sanctioned retry.
    completed.add(key);
    state.completedKeys = [...completed];
    state.updatedAt = now();
    await deps.store.putMigrationState(state);
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
  const existing = await deps.store.load(key);
  if (existing && existing.version === CONVERSATION_RECORD_VERSION) return 'already';

  const identity = {
    key,
    workUnitId: unit.jid,
    workspaceId: workspaceIdFor(unit),
    folder: unit.folder,
    legacyKeys: { agentSessionId: unit.jid, chatSessionId: chatSessionIdFor(unit) },
  };

  const agentSession = await deps.loadAgentSession(unit.jid);
  if (agentSession && !Array.isArray(agentSession.messages)) {
    // A half-written / truncated legacy record. Refusing it here means the
    // unit is recorded as skipped and keeps reading the legacy store, where
    // a later build can still repair it — the #2006 rule: never wipe.
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

  // A unit with no conversation anywhere (a scoop registered but never fed).
  // No empty record is written: absence is what makes the legacy fallback
  // fire, and a placeholder would claim a conversation exists.
  return 'empty';
}

/** Load the cursor, or start a fresh one when it is missing or outdated. */
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
