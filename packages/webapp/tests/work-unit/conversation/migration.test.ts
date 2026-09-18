import { beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import type { AgentMessage } from '../../../src/core/index.js';
import type { ChatMessage } from '../../../src/scoops/chat-types.js';
import type { RegisteredScoop } from '../../../src/scoops/types.js';
import { toAgentMessages, toChatMessages } from '../../../src/work-unit/conversation/derive.js';
import { conversationKeyFor } from '../../../src/work-unit/conversation/key.js';
import {
  CONVERSATION_MIGRATION_ID,
  CONVERSATION_MIGRATION_VERSION,
  migrateConversations,
} from '../../../src/work-unit/conversation/migration.js';
import { WorkUnitConversationStore } from '../../../src/work-unit/conversation/store.js';
import { CONVERSATION_RECORD_VERSION } from '../../../src/work-unit/conversation/types.js';
import { childRecord, rootRecord } from '../fixtures.js';
import {
  legacyAgentMessages,
  legacyChatMessages,
  POISONED_READ_ERROR,
  poisonedAgentSession,
  preParentJidRecord,
} from './fixtures.js';

let dbCounter = 0;

function newStore(): WorkUnitConversationStore {
  dbCounter++;
  return new WorkUnitConversationStore({ dbName: `test-migration-${dbCounter}` });
}

interface LegacyStores {
  agent: Map<string, { messages: AgentMessage[]; createdAt?: number }>;
  chat: Map<string, { messages: ChatMessage[]; createdAt?: number }>;
}

function legacyStores(): LegacyStores {
  return { agent: new Map(), chat: new Map() };
}

function depsFor(
  store: WorkUnitConversationStore,
  units: RegisteredScoop[],
  legacy: LegacyStores,
  overrides: Partial<Parameters<typeof migrateConversations>[0]> = {}
): Parameters<typeof migrateConversations>[0] {
  return {
    store,
    units,
    loadAgentSession: async (id) => legacy.agent.get(id) ?? null,
    loadChatSession: async (id) => legacy.chat.get(id) ?? null,
    now: () => 1_000,
    ...overrides,
  };
}

describe('migrateConversations', () => {
  let store: WorkUnitConversationStore;
  let legacy: LegacyStores;

  beforeEach(() => {
    store = newStore();
    legacy = legacyStores();
  });

  it('builds a canonical record from Pi history', async () => {
    const cone = rootRecord();
    legacy.agent.set(cone.jid, { messages: legacyAgentMessages(), createdAt: 500 });

    const summary = await migrateConversations(depsFor(store, [cone], legacy));

    expect(summary).toEqual({ migrated: 1, alreadyDone: 0, empty: 0, skipped: 0 });
    const record = await store.load(conversationKeyFor(cone));
    expect(record?.origin).toBe('agent-history');
    expect(record?.migratedFrom).toBe('agent-sessions');
    expect(record?.createdAt).toBe(500);
    expect(toAgentMessages(record)).toEqual(legacyAgentMessages());
  });

  it('never touches the legacy stores', async () => {
    const cone = rootRecord();
    legacy.agent.set(cone.jid, { messages: legacyAgentMessages() });
    legacy.chat.set('session-cone', { messages: legacyChatMessages() });

    await migrateConversations(depsFor(store, [cone], legacy));

    expect(legacy.agent.get(cone.jid)?.messages).toEqual(legacyAgentMessages());
    expect(legacy.chat.get('session-cone')?.messages).toEqual(legacyChatMessages());
  });

  it('falls back to the UI projection when Pi history is gone', async () => {
    const cone = rootRecord();
    legacy.chat.set('session-cone', { messages: legacyChatMessages(), createdAt: 700 });

    await migrateConversations(depsFor(store, [cone], legacy));

    const record = await store.load(conversationKeyFor(cone));
    expect(record?.origin).toBe('ui-projection');
    expect(record?.migratedFrom).toBe('browser-coding-agent');
    expect(await toChatMessages(record)).toEqual(legacyChatMessages());

    expect(toAgentMessages(record)).toEqual([]);
  });

  it('prefers Pi history over the UI projection', async () => {
    const cone = rootRecord();
    legacy.agent.set(cone.jid, { messages: legacyAgentMessages() });
    legacy.chat.set('session-cone', { messages: legacyChatMessages() });

    await migrateConversations(depsFor(store, [cone], legacy));

    expect((await store.load(conversationKeyFor(cone)))?.origin).toBe('agent-history');
  });

  it('writes no record for a unit that never spoke', async () => {
    const cone = rootRecord();
    const summary = await migrateConversations(depsFor(store, [cone], legacy));
    expect(summary.empty).toBe(1);
    expect(await store.load(conversationKeyFor(cone))).toBeNull();
  });

  it('migrates a record saved before parentJid existed', async () => {
    const legacyUnit = preParentJidRecord();
    legacy.agent.set(legacyUnit.jid, { messages: legacyAgentMessages() });

    await migrateConversations(depsFor(store, [legacyUnit], legacy));

    const record = await store.load('/workspace::cone_legacy');
    expect(record?.workspaceId).toBe('/workspace');
    expect(record?.legacyKeys).toEqual({
      agentSessionId: 'cone_legacy',
      chatSessionId: 'session-cone',
    });
  });

  it('keys a scoop by its own workspace, not the cone it belongs to', async () => {
    const cone = rootRecord();
    const scoop = childRecord(cone.jid);
    legacy.agent.set(scoop.jid, { messages: legacyAgentMessages() });

    await migrateConversations(depsFor(store, [cone, scoop], legacy));

    expect(await store.listKeys()).toEqual([
      '/scoops/worker-scoop/workspace::scoop_worker-scoop_1',
    ]);
  });

  it('skips a unit whose legacy read throws, and keeps going', async () => {
    const cone = rootRecord();
    const scoop = childRecord(cone.jid);
    legacy.agent.set(scoop.jid, { messages: legacyAgentMessages() });

    const summary = await migrateConversations(
      depsFor(store, [cone, scoop], legacy, {
        loadAgentSession: async (id) => {
          if (id === cone.jid) throw new Error(POISONED_READ_ERROR);
          return legacy.agent.get(id) ?? null;
        },
      })
    );

    expect(summary.skipped).toBe(1);
    expect(summary.migrated).toBe(1);
    expect(await store.load(conversationKeyFor(scoop))).not.toBeNull();
    const state = await store.getMigrationState(CONVERSATION_MIGRATION_ID);
    expect(state?.skipped[0]?.reason).toContain(POISONED_READ_ERROR);
  });

  it('skips a payload whose shape is a lie without deleting it', async () => {
    const cone = rootRecord();
    const poisoned = poisonedAgentSession();
    legacy.agent.set(cone.jid, poisoned);

    const summary = await migrateConversations(depsFor(store, [cone], legacy));

    expect(summary.skipped).toBe(1);
    expect(await store.load(conversationKeyFor(cone))).toBeNull();
    expect(legacy.agent.get(cone.jid)).toBe(poisoned);
  });

  it('resumes from the cursor after a crash mid-pass', async () => {
    const cone = rootRecord();
    const scoop = childRecord(cone.jid);
    legacy.agent.set(cone.jid, { messages: legacyAgentMessages() });
    legacy.agent.set(scoop.jid, { messages: legacyAgentMessages() });

    const boom = new Error('tab died');
    await expect(
      migrateConversations(
        depsFor(store, [cone, scoop], legacy, {
          loadAgentSession: async (id) => {
            if (id === scoop.jid) throw boom;
            return legacy.agent.get(id) ?? null;
          },

          now: () => 1_000,
        })
      )
    ).resolves.toMatchObject({ migrated: 1, skipped: 1 });

    const state = await store.getMigrationState(CONVERSATION_MIGRATION_ID);
    expect(state?.completedKeys).toHaveLength(2);

    const loadAgentSession = vi.fn(async () => null);
    const second = await migrateConversations(
      depsFor(store, [cone, scoop], legacy, { loadAgentSession })
    );
    expect(second.alreadyDone).toBe(2);
    expect(loadAgentSession).not.toHaveBeenCalled();
  });

  it('picks up where an interrupted pass stopped', async () => {
    const cone = rootRecord();
    const scoop = childRecord(cone.jid);
    legacy.agent.set(cone.jid, { messages: legacyAgentMessages() });
    legacy.agent.set(scoop.jid, { messages: legacyAgentMessages() });

    await store.putMigrationState({
      id: CONVERSATION_MIGRATION_ID,
      version: 1,
      completedKeys: [conversationKeyFor(cone)],
      skipped: [],
      done: false,
      startedAt: 1,
      updatedAt: 1,
    });

    const loadAgentSession = vi.fn(async (id: string) => legacy.agent.get(id) ?? null);
    const summary = await migrateConversations(
      depsFor(store, [cone, scoop], legacy, { loadAgentSession })
    );

    expect(summary).toEqual({ migrated: 1, alreadyDone: 1, empty: 0, skipped: 0 });
    expect(loadAgentSession).toHaveBeenCalledTimes(1);
    expect(loadAgentSession).toHaveBeenCalledWith(scoop.jid);
  });

  it('re-runs everything when the record schema version moves', async () => {
    const cone = rootRecord();
    legacy.agent.set(cone.jid, { messages: legacyAgentMessages() });
    await store.putMigrationState({
      id: CONVERSATION_MIGRATION_ID,
      version: 0,
      completedKeys: [conversationKeyFor(cone)],
      skipped: [],
      done: true,
      startedAt: 1,
      updatedAt: 1,
    });

    const summary = await migrateConversations(depsFor(store, [cone], legacy));

    expect(summary.migrated).toBe(1);
  });

  it('does not re-run for a record-schema bump (#2365 v2)', async () => {
    const cone = rootRecord();
    legacy.agent.set(cone.jid, { messages: legacyAgentMessages() });
    await store.putMigrationState({
      id: CONVERSATION_MIGRATION_ID,
      version: CONVERSATION_MIGRATION_VERSION,
      completedKeys: [conversationKeyFor(cone)],
      skipped: [],
      done: true,
      startedAt: 1,
      updatedAt: 1,
    });

    const summary = await migrateConversations(depsFor(store, [cone], legacy));

    expect(CONVERSATION_RECORD_VERSION).not.toBe(CONVERSATION_MIGRATION_VERSION);
    expect(summary.migrated).toBe(0);
    expect(await store.load(conversationKeyFor(cone))).toBeNull();
  });

  it('heartbeats after every unit so a long pass cannot trip the boot watchdog', async () => {
    const cone = rootRecord();
    const scoop = childRecord(cone.jid);
    legacy.agent.set(cone.jid, { messages: legacyAgentMessages() });
    const onProgress = vi.fn();

    await migrateConversations(depsFor(store, [cone, scoop], legacy, { onProgress }));

    expect(onProgress.mock.calls.map((c) => c[0])).toEqual([
      `conversation-migrated:${cone.jid}`,
      `conversation-migrated:${scoop.jid}`,
    ]);
  });

  it('leaves a newer-schema record untouched on a rollback', async () => {
    const cone = rootRecord();
    legacy.agent.set(cone.jid, { messages: legacyAgentMessages() });
    const future = {
      key: conversationKeyFor(cone),
      version: 99,
      workUnitId: cone.jid,
      workspaceId: '/workspace',
      folder: 'cone',
      origin: 'agent-history' as const,
      entries: [],
      createdAt: 1,
      updatedAt: 1,
      legacyKeys: { agentSessionId: cone.jid, chatSessionId: 'session-cone' },
    };
    await store.save(future);

    const summary = await migrateConversations(depsFor(store, [cone], legacy));

    expect(summary.migrated).toBe(0);
    expect((await store.read(conversationKeyFor(cone))).status).toBe('incompatible');
  });

  it('skips — rather than overwrites — a unit whose canonical record cannot be read', async () => {
    const cone = rootRecord();
    legacy.agent.set(cone.jid, { messages: legacyAgentMessages() });
    vi.spyOn(store, 'read').mockResolvedValue({ status: 'error', reason: 'IndexedDB unavailable' });

    const summary = await migrateConversations(depsFor(store, [cone], legacy));

    expect(summary.skipped).toBe(1);
    const state = await store.getMigrationState(CONVERSATION_MIGRATION_ID);
    expect(state?.skipped[0]?.reason).toContain('IndexedDB unavailable');
  });

  it('retries a unit whose canonical record could not be read on the next boot (#2365)', async () => {
    const cone = rootRecord();
    const scoop = childRecord(cone.jid);
    legacy.agent.set(cone.jid, { messages: legacyAgentMessages() });
    legacy.agent.set(scoop.jid, { messages: legacyAgentMessages() });
    const realRead = store.read.bind(store);
    const read = vi
      .spyOn(store, 'read')
      .mockImplementation(async (key) =>
        key === conversationKeyFor(cone)
          ? { status: 'error', reason: 'IndexedDB unavailable' }
          : realRead(key)
      );

    const first = await migrateConversations(depsFor(store, [cone, scoop], legacy));
    const cursor = await store.getMigrationState(CONVERSATION_MIGRATION_ID);
    expect(first).toMatchObject({ migrated: 1, skipped: 1 });
    expect(cursor?.done).toBe(false);
    expect(cursor?.completedKeys).toEqual([conversationKeyFor(scoop)]);

    read.mockRestore();
    const second = await migrateConversations(depsFor(store, [cone, scoop], legacy));

    expect(second).toMatchObject({ migrated: 1, alreadyDone: 1, skipped: 0 });
    expect(await store.load(conversationKeyFor(cone))).not.toBeNull();
    const done = await store.getMigrationState(CONVERSATION_MIGRATION_ID);
    expect(done?.done).toBe(true);

    expect(done?.skipped).toHaveLength(1);
  });

  it('leaves a record it already migrated alone', async () => {
    const cone = rootRecord();
    legacy.agent.set(cone.jid, { messages: legacyAgentMessages() });
    await migrateConversations(depsFor(store, [cone], legacy));
    const before = await store.load(conversationKeyFor(cone));

    await store.putMigrationState({
      id: CONVERSATION_MIGRATION_ID,
      version: 1,
      completedKeys: [],
      skipped: [],
      done: false,
      startedAt: 1,
      updatedAt: 1,
    });
    const summary = await migrateConversations(depsFor(store, [cone], legacy));

    expect(summary.alreadyDone).toBe(1);
    expect(await store.load(conversationKeyFor(cone))).toEqual(before);
  });
});
