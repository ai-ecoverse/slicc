/**
 * `WorkUnitConversationStore` against fake-indexeddb (#2275).
 *
 * Each suite gets its own database name — the `dbCounter` isolation rule
 * from `.agents/skills/writing-slicc-tests` — so an append in one test can
 * never be read by another.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import type { AgentMessage } from '../../../src/core/index.js';
import type { ConversationIdentity } from '../../../src/work-unit/conversation/store.js';
import { WorkUnitConversationStore } from '../../../src/work-unit/conversation/store.js';
import { legacyAgentMessages } from './fixtures.js';

let dbCounter = 0;

function newStore(): WorkUnitConversationStore {
  dbCounter++;
  return new WorkUnitConversationStore({ dbName: `test-work-units-${dbCounter}` });
}

const identity: ConversationIdentity = {
  key: '/workspace::cone_1',
  workUnitId: 'cone_1',
  workspaceId: '/workspace',
  folder: 'cone',
  legacyKeys: { agentSessionId: 'cone_1', chatSessionId: 'session-cone' },
};

describe('WorkUnitConversationStore', () => {
  let store: WorkUnitConversationStore;

  beforeEach(() => {
    store = newStore();
  });

  it('answers null for a unit it has never seen', async () => {
    expect(await store.load(identity.key)).toBeNull();
  });

  it('creates a record on the first write', async () => {
    const record = await store.syncAgentMessages(identity, legacyAgentMessages());
    expect(record?.workUnitId).toBe('cone_1');
    expect(record?.origin).toBe('agent-history');
    expect(record?.legacyKeys.chatSessionId).toBe('session-cone');
    expect(await store.load(identity.key)).toEqual(record);
  });

  it('writes nothing for an empty conversation', async () => {
    expect(await store.syncAgentMessages(identity, [])).toBeNull();
    expect(await store.load(identity.key)).toBeNull();
  });

  it('appends the tail of a growing conversation and keeps createdAt', async () => {
    const messages = legacyAgentMessages();
    const first = await store.syncAgentMessages(identity, messages.slice(0, 2), { now: 1000 });
    const second = await store.syncAgentMessages(identity, messages, { now: 2000 });
    expect(first?.entries).toHaveLength(3);
    expect(second?.entries).toHaveLength(5);
    expect(second?.entries.slice(0, 3)).toEqual(first?.entries);
    expect(second?.createdAt).toBe(first?.createdAt);
    expect(second?.updatedAt).toBe(2000);
    expect(second?.rewrites).toBeUndefined();
  });

  it('is a no-op when nothing changed mid-turn', async () => {
    const messages = legacyAgentMessages();
    const first = await store.syncAgentMessages(identity, messages, { now: 1000 });
    const again = await store.syncAgentMessages(identity, messages, { now: 2000 });
    // The stored record comes back untouched — no second IndexedDB write.
    expect(again).toEqual(first);
    expect((await store.load(identity.key))?.updatedAt).toBe(1000);
  });

  it('counts a rewrite when history is replaced wholesale (compaction)', async () => {
    await store.syncAgentMessages(identity, legacyAgentMessages());
    const compacted = [
      { role: 'user', content: [{ type: 'text', text: 'summary of earlier work' }] },
    ] as unknown as AgentMessage[];
    const after = await store.syncAgentMessages(identity, compacted);
    expect(after?.entries).toHaveLength(1);
    expect(after?.rewrites).toBe(1);
  });

  it('does not read a rewrite into a message a provider merely annotated', async () => {
    const messages = legacyAgentMessages();
    await store.syncAgentMessages(identity, messages, { now: 1000 });
    const annotated = messages.map((m) => ({ ...m, providerMeta: { region: 'eu' } }));
    const after = await store.syncAgentMessages(identity, annotated as AgentMessage[], {
      now: 2000,
    });
    expect(after?.rewrites).toBeUndefined();
    expect(after?.updatedAt).toBe(1000);
  });

  it('forgets a dropped unit', async () => {
    await store.syncAgentMessages(identity, legacyAgentMessages());
    await store.delete(identity.key);
    expect(await store.load(identity.key)).toBeNull();
  });

  it('lists the keys it holds', async () => {
    await store.syncAgentMessages(identity, legacyAgentMessages());
    expect(await store.listKeys()).toEqual([identity.key]);
  });

  it('ignores a record written by a newer schema instead of overwriting it', async () => {
    const written = await store.syncAgentMessages(identity, legacyAgentMessages());
    await store.save({ ...written!, version: 99 });
    expect(await store.load(identity.key)).toBeNull();
    // Still on disk for the newer build that wrote it.
    expect(await store.listKeys()).toEqual([identity.key]);
  });

  it('ignores a record whose entry list is not a list', async () => {
    const written = await store.syncAgentMessages(identity, legacyAgentMessages());
    await store.save({ ...written!, entries: 'poisoned' as never });
    expect(await store.load(identity.key)).toBeNull();
  });

  it('never writes over a record from a newer schema', async () => {
    // A rollback: the newer build's history may only exist in a shape this
    // one cannot express, so an "absent-looking" read must not become a
    // create. Codex caught this on #2364.
    const written = await store.syncAgentMessages(identity, legacyAgentMessages());
    const future = { ...written!, version: 99, entries: [] };
    await store.save(future);

    expect(await store.load(identity.key)).toBeNull();
    expect(await store.syncAgentMessages(identity, legacyAgentMessages())).toBeNull();
    expect((await store.read(identity.key)).status).toBe('incompatible');
  });

  it('never writes over a record it merely failed to read', async () => {
    await store.syncAgentMessages(identity, legacyAgentMessages(), { now: 1000 });
    const readSpy = vi.spyOn(store, 'read').mockResolvedValue({
      status: 'error',
      reason: 'IndexedDB unavailable',
    });

    expect(await store.syncAgentMessages(identity, [])).toBeNull();
    readSpy.mockRestore();
    // The record is exactly as it was.
    expect((await store.load(identity.key))?.updatedAt).toBe(1000);
  });

  it('repairs a record whose stored shape is broken', async () => {
    const written = await store.syncAgentMessages(identity, legacyAgentMessages());
    await store.save({ ...written!, entries: 'poisoned' as never });
    expect((await store.read(identity.key)).status).toBe('malformed');

    const repaired = await store.syncAgentMessages(identity, legacyAgentMessages());

    expect(repaired?.entries).toHaveLength(5);
  });

  it('round-trips the migration cursor', async () => {
    expect(await store.getMigrationState('conversations')).toBeNull();
    const state = {
      id: 'conversations',
      version: 1,
      completedKeys: [identity.key],
      skipped: [],
      done: false,
      startedAt: 1,
      updatedAt: 2,
    };
    await store.putMigrationState(state);
    expect(await store.getMigrationState('conversations')).toEqual(state);
  });

  it('clearAll drops records and cursor — the documented rollback', async () => {
    await store.syncAgentMessages(identity, legacyAgentMessages());
    await store.putMigrationState({
      id: 'conversations',
      version: 1,
      completedKeys: [identity.key],
      skipped: [],
      done: true,
      startedAt: 1,
      updatedAt: 1,
    });
    await store.clearAll();
    expect(await store.listKeys()).toEqual([]);
    expect(await store.getMigrationState('conversations')).toBeNull();
  });
});
