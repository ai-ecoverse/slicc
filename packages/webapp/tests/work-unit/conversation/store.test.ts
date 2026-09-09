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
import type { ConversationMarker } from '../../../src/work-unit/conversation/types.js';
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

  it('rekey moves a record to the post-promote workspace identity (#2278)', async () => {
    const from: ConversationIdentity = {
      key: '/scoops/worker-scoop/workspace::scoop_worker-scoop_1',
      workUnitId: 'scoop_worker-scoop_1',
      workspaceId: '/scoops/worker-scoop/workspace',
      folder: 'worker-scoop',
      legacyKeys: {
        agentSessionId: 'scoop_worker-scoop_1',
        chatSessionId: 'session-worker-scoop',
      },
    };
    const to: ConversationIdentity = {
      key: '/cones/worker-scoop/workspace::scoop_worker-scoop_1',
      workUnitId: 'scoop_worker-scoop_1',
      workspaceId: '/cones/worker-scoop/workspace',
      folder: 'worker-scoop',
      legacyKeys: from.legacyKeys,
    };
    await store.syncAgentMessages(from, legacyAgentMessages());
    await store.rekey(from.key, to);
    expect(await store.load(from.key)).toBeNull();
    const moved = await store.load(to.key);
    expect(moved?.workspaceId).toBe(to.workspaceId);
    expect(moved?.key).toBe(to.key);
    expect(moved?.entries).toHaveLength(5);
  });

  describe('markers', () => {
    const marker = (over: Partial<ConversationMarker> = {}): ConversationMarker => ({
      id: 'compaction-cone_1-abc',
      kind: 'compaction',
      timestamp: 5000,
      compaction: { trigger: 'idle', state: 'summarizing' },
      ...over,
    });

    it('settles a round in place instead of stacking rows', async () => {
      await store.syncAgentMessages(identity, legacyAgentMessages());
      expect(await store.putMarker(identity.key, marker())).toBe(true);
      expect(
        await store.putMarker(
          identity.key,
          marker({ compaction: { trigger: 'idle', state: 'summarized' } })
        )
      ).toBe(true);
      const markers = (await store.load(identity.key))?.markers;
      expect(markers).toHaveLength(1);
      expect(markers?.[0].compaction.state).toBe('summarized');
    });

    it('survives the compaction that produced it', async () => {
      // The whole point: `syncAgentMessages` replaces `entries` wholesale on
      // a compaction, and the marker announcing it must not go with them.
      await store.syncAgentMessages(identity, legacyAgentMessages());
      await store.putMarker(identity.key, marker());
      const compacted = [
        { role: 'user', content: [{ type: 'text', text: 'summary of earlier work' }] },
      ] as unknown as AgentMessage[];
      const after = await store.syncAgentMessages(identity, compacted);
      expect(after?.entries).toHaveLength(1);
      expect(after?.markers).toHaveLength(1);
    });

    it('retracts a round that kept nothing', async () => {
      await store.syncAgentMessages(identity, legacyAgentMessages());
      await store.putMarker(identity.key, marker());
      expect(await store.deleteMarker(identity.key, marker().id)).toBe(true);
      expect((await store.load(identity.key))?.markers).toEqual([]);
      // Already gone: nothing to write, and not an error either.
      expect(await store.deleteMarker(identity.key, marker().id)).toBe(false);
    });

    it('keeps markers in timestamp order and caps the list', async () => {
      await store.syncAgentMessages(identity, legacyAgentMessages());
      for (let i = 0; i < 70; i++) {
        await store.putMarker(identity.key, marker({ id: `m${i}`, timestamp: 1000 + i }));
      }
      const markers = (await store.load(identity.key))?.markers ?? [];
      expect(markers).toHaveLength(64);
      // Oldest went first, and what is left is still ascending.
      expect(markers[0].id).toBe('m6');
      expect(markers.map((m) => m.timestamp)).toEqual([...markers.map((m) => m.timestamp)].sort());
    });

    it('refuses to annotate a conversation that is not stored', async () => {
      // An annotation with no conversation under it would derive to a
      // transcript that is nothing but seams.
      expect(await store.putMarker(identity.key, marker())).toBe(false);
      expect(await store.load(identity.key)).toBeNull();
    });

    it('never writes over a newer schema or a failed read', async () => {
      const written = await store.syncAgentMessages(identity, legacyAgentMessages());
      await store.save({ ...written!, version: 99 });
      expect(await store.putMarker(identity.key, marker())).toBe(false);

      await store.save({ ...written!, version: 1 });
      const readSpy = vi
        .spyOn(store, 'read')
        .mockResolvedValue({ status: 'error', reason: 'IndexedDB unavailable' });
      expect(await store.putMarker(identity.key, marker())).toBe(false);
      readSpy.mockRestore();
      expect((await store.load(identity.key))?.markers).toBeUndefined();
    });

    // The real sequence of an adopted idle compaction: the round settles its
    // marker while its caller persists the freshly compacted history. Both
    // read the record and then save a whole copy, so without a per-key queue
    // the later save wins outright — dropping the marker, or reinstating the
    // pre-compaction entries it just replaced.
    it('does not lose either write when a marker and a history sync overlap', async () => {
      await store.syncAgentMessages(identity, legacyAgentMessages(), { now: 1000 });
      const compacted = [
        { role: 'user', content: [{ type: 'text', text: 'summary of earlier work' }] },
      ] as unknown as AgentMessage[];

      // Started in the same tick, deliberately un-awaited between.
      const written = store.putMarker(
        identity.key,
        marker({ compaction: { trigger: 'idle', state: 'summarized' } })
      );
      const synced = store.syncAgentMessages(identity, compacted, { now: 2000 });
      expect(await Promise.all([written, synced])).toEqual([true, expect.anything()]);

      const record = await store.load(identity.key);
      expect(record?.entries).toHaveLength(1);
      expect(record?.markers).toHaveLength(1);
    });

    it('keeps every marker when a burst of rounds settles at once', async () => {
      await store.syncAgentMessages(identity, legacyAgentMessages());

      await Promise.all(
        [1, 2, 3, 4, 5].map((i) =>
          store.putMarker(identity.key, marker({ id: `m${i}`, timestamp: 1000 + i }))
        )
      );

      expect((await store.load(identity.key))?.markers?.map((m) => m.id)).toEqual([
        'm1',
        'm2',
        'm3',
        'm4',
        'm5',
      ]);
    });
  });

  it('rekey is a no-op when keys match or the source is absent', async () => {
    await store.rekey(identity.key, identity);
    expect(await store.load(identity.key)).toBeNull();
    await store.rekey('/scoops/missing/workspace::x', {
      ...identity,
      key: '/cones/missing/workspace::x',
      workspaceId: '/cones/missing/workspace',
    });
    expect(await store.listKeys()).toEqual([]);
  });
});
