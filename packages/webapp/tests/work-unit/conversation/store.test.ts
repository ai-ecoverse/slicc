import { beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import type { AgentMessage } from '../../../src/core/index.js';
import { entriesFromChatMessages } from '../../../src/work-unit/conversation/entries.js';
import type { ConversationIdentity } from '../../../src/work-unit/conversation/store.js';
import { WorkUnitConversationStore } from '../../../src/work-unit/conversation/store.js';
import type { CompactionConversationMarker } from '../../../src/work-unit/conversation/types.js';
import { CONVERSATION_RECORD_VERSION } from '../../../src/work-unit/conversation/types.js';
import { legacyAgentMessages, legacyChatMessages } from './fixtures.js';

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

  it('delete queues behind in-flight syncs for the same key', async () => {
    const messages = legacyAgentMessages();
    const first = store.syncAgentMessages(identity, messages);
    const second = store.syncAgentMessages(identity, [...messages, ...legacyAgentMessages()]);
    await store.delete(identity.key);

    await Promise.all([first, second]);
    expect(await store.load(identity.key)).toBeNull();

    const other = { ...identity, key: '/workspace::cone_2', workUnitId: 'cone_2' };
    await store.syncAgentMessages(other, messages);
    expect(await store.load(other.key)).not.toBeNull();
  });

  it('lists the keys it holds', async () => {
    await store.syncAgentMessages(identity, legacyAgentMessages());
    expect(await store.listKeys()).toEqual([identity.key]);
  });

  it('ignores a record written by a newer schema instead of overwriting it', async () => {
    const written = await store.syncAgentMessages(identity, legacyAgentMessages());
    await store.save({ ...written!, version: 99 });
    expect(await store.load(identity.key)).toBeNull();

    expect(await store.listKeys()).toEqual([identity.key]);
  });

  it('ignores a record whose entry list is not a list', async () => {
    const written = await store.syncAgentMessages(identity, legacyAgentMessages());
    await store.save({ ...written!, entries: 'poisoned' as never });
    expect(await store.load(identity.key)).toBeNull();
  });

  it('never writes over a record from a newer schema', async () => {
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
    const marker = (
      over: Partial<CompactionConversationMarker> = {}
    ): CompactionConversationMarker => ({
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
      const markers = (await store.load(identity.key))?.markers as
        | CompactionConversationMarker[]
        | undefined;
      expect(markers).toHaveLength(1);
      expect(markers?.[0].compaction.state).toBe('summarized');
    });

    it('survives the compaction that produced it', async () => {
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

      expect(await store.deleteMarker(identity.key, marker().id)).toBe(false);
    });

    it('keeps markers in timestamp order and caps the list', async () => {
      await store.syncAgentMessages(identity, legacyAgentMessages());
      for (let i = 0; i < 70; i++) {
        await store.putMarker(identity.key, marker({ id: `m${i}`, timestamp: 1000 + i }));
      }
      const markers = (await store.load(identity.key))?.markers ?? [];
      expect(markers).toHaveLength(64);

      expect(markers[0].id).toBe('m6');
      expect(markers.map((m) => m.timestamp)).toEqual([...markers.map((m) => m.timestamp)].sort());
    });

    it('refuses to annotate a conversation that is not stored', async () => {
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

    it('does not lose either write when a marker and a history sync overlap', async () => {
      await store.syncAgentMessages(identity, legacyAgentMessages(), { now: 1000 });
      const compacted = [
        { role: 'user', content: [{ type: 'text', text: 'summary of earlier work' }] },
      ] as unknown as AgentMessage[];

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

describe('WorkUnitConversationStore after the #2365 cut', () => {
  let store: WorkUnitConversationStore;

  beforeEach(() => {
    store = newStore();
  });

  async function saveUiProjection(): Promise<void> {
    await store.save({
      ...identity,
      version: CONVERSATION_RECORD_VERSION,
      origin: 'ui-projection',
      entries: entriesFromChatMessages(legacyChatMessages()),
      createdAt: 7,
      updatedAt: 7,
      migratedFrom: 'browser-coding-agent',
    });
  }

  it('keeps a ui-projection transcript as the prefix when a live agent continues it', async () => {
    await saveUiProjection();

    const record = await store.syncAgentMessages(identity, legacyAgentMessages());

    expect(record?.origin).toBe('agent-history');
    expect(record?.projectionPrefix).toEqual(legacyChatMessages());
    expect(record?.entries.every((e) => e.kind === 'tool-call' || e.message)).toBe(true);
    expect(record?.rewrites).toBeUndefined();
    expect(record?.createdAt).toBe(7);
  });

  it('carries the prefix through later appends and rewrites', async () => {
    await saveUiProjection();
    const messages = legacyAgentMessages();
    await store.syncAgentMessages(identity, messages.slice(0, 2));
    await store.syncAgentMessages(identity, messages);
    const compacted = await store.syncAgentMessages(identity, messages.slice(2));

    expect(compacted?.rewrites).toBe(1);
    expect(compacted?.projectionPrefix).toEqual(legacyChatMessages());
  });

  it('leaves a ui-projection record alone when there is no Pi history to add', async () => {
    await saveUiProjection();
    expect((await store.syncAgentMessages(identity, []))?.origin).toBe('ui-projection');
  });

  it('lists every readable record', async () => {
    await store.syncAgentMessages(identity, legacyAgentMessages());
    await store.save({
      ...identity,
      key: '/workspace::cone_future',
      workUnitId: 'cone_future',
      version: CONVERSATION_RECORD_VERSION + 1,
      origin: 'agent-history',
      entries: [],
      createdAt: 1,
      updatedAt: 1,
    });

    expect((await store.loadAll()).map((r) => r.workUnitId)).toEqual(['cone_1']);
  });

  it('finds the newest record in a workspace, and only that workspace', async () => {
    const other = {
      ...identity,
      key: '/cones/cone-two/workspace::cone_2',
      workUnitId: 'cone_2',
      workspaceId: '/cones/cone-two/workspace',
      folder: 'cone-two',
    };
    await store.syncAgentMessages(identity, legacyAgentMessages(), { now: 1 });
    await store.syncAgentMessages(
      { ...identity, key: '/workspace::cone_new', workUnitId: 'cone_new' },
      legacyAgentMessages().slice(0, 1),
      { now: 2 }
    );
    await store.syncAgentMessages(other, legacyAgentMessages(), { now: 3 });

    expect((await store.loadLatestInWorkspace('/workspace'))?.workUnitId).toBe('cone_new');
    expect((await store.loadLatestInWorkspace('/cones/cone-two/workspace'))?.workUnitId).toBe(
      'cone_2'
    );

    expect(await store.loadLatestInWorkspace('/cones/cone')).toBeNull();
  });

  it('answers empty rather than throwing when the database will not open', async () => {
    const broken = newStore();
    vi.spyOn(broken as unknown as { getDb: () => Promise<never> }, 'getDb').mockRejectedValue(
      new Error('IndexedDB unavailable')
    );
    expect(await broken.loadAll()).toEqual([]);
    expect(await broken.loadLatestInWorkspace('/workspace')).toBeNull();
  });

  describe('schema version stamping', () => {
    const errorMarker = { id: 'err-1', kind: 'error' as const, timestamp: 5, text: 'boom' };

    it('keeps an ordinary record at v1, so a pre-#2365 build still reads it', async () => {
      await store.syncAgentMessages(identity, legacyAgentMessages());
      expect((await store.read(identity.key)).status).toBe('ok');
      const raw = await store.load(identity.key);
      expect(raw?.version).toBe(1);
    });

    it('stamps v2 on a record carrying an error marker, and v1 again once it is gone', async () => {
      await store.syncAgentMessages(identity, legacyAgentMessages());
      await store.putMarker(identity.key, errorMarker);
      expect((await store.load(identity.key))?.version).toBe(2);

      await store.deleteMarker(identity.key, errorMarker.id);
      expect((await store.load(identity.key))?.version).toBe(1);
    });

    it('stamps v2 on a record carrying a projection prefix', async () => {
      await saveUiProjection();
      await store.syncAgentMessages(identity, legacyAgentMessages());
      expect((await store.load(identity.key))?.version).toBe(2);
    });

    it("never lowers a newer build's version", async () => {
      await store.save({
        ...identity,
        version: CONVERSATION_RECORD_VERSION + 1,
        origin: 'agent-history',
        entries: [],
        createdAt: 1,
        updatedAt: 1,
      });
      expect(await store.read(identity.key)).toEqual({
        status: 'incompatible',
        version: CONVERSATION_RECORD_VERSION + 1,
      });
    });
  });

  describe('marker-only records', () => {
    const errorMarker = { id: 'err-1', kind: 'error' as const, timestamp: 5, text: 'bad key' };

    it('creates the record for a marker when asked to', async () => {
      expect(await store.putMarker(identity.key, errorMarker, { createWith: identity })).toBe(true);
      const record = await store.load(identity.key);
      expect(record).toMatchObject({
        workUnitId: 'cone_1',
        origin: 'agent-history',
        entries: [],
        markers: [errorMarker],
      });

      await store.syncAgentMessages(identity, legacyAgentMessages());
      const after = await store.load(identity.key);
      expect(after?.markers).toEqual([errorMarker]);
      expect(after?.rewrites).toBeUndefined();
    });

    it('still declines an absent record without createWith', async () => {
      expect(await store.putMarker(identity.key, errorMarker)).toBe(false);
      expect(await store.load(identity.key)).toBeNull();
    });

    it("never creates over a newer build's record", async () => {
      await store.save({
        ...identity,
        version: CONVERSATION_RECORD_VERSION + 1,
        origin: 'agent-history',
        entries: [],
        createdAt: 1,
        updatedAt: 1,
      });
      expect(await store.putMarker(identity.key, errorMarker, { createWith: identity })).toBe(
        false
      );
    });
  });

  describe('attachment overlays', () => {
    const overlay = (id: string, timestamp: number) => ({
      id,
      timestamp,
      body: `body ${id}`,
      attachments: [
        { id: `att-${id}`, name: 'a.txt', mimeType: 'text/plain', size: 1, kind: 'text' as const },
      ],
    });

    it('creates the record when the first message carries an attachment', async () => {
      expect(await store.putAttachments(identity, [overlay('m1', 1)])).toBe(true);
      const record = await store.load(identity.key);
      expect(record).toMatchObject({ entries: [], attachments: [overlay('m1', 1)] });

      expect(record?.version).toBe(1);
    });

    it('upserts by message id and survives the checkpoint and a compaction rewrite', async () => {
      await store.putAttachments(identity, [overlay('m2', 2), overlay('m1', 1)]);
      await store.putAttachments(identity, [{ ...overlay('m1', 1), body: 'resent' }]);
      const messages = legacyAgentMessages();
      await store.syncAgentMessages(identity, messages);
      await store.syncAgentMessages(identity, messages.slice(2));

      const record = await store.load(identity.key);
      expect(record?.rewrites).toBe(1);
      expect(record?.attachments?.map((o) => [o.id, o.body])).toEqual([
        ['m1', 'resent'],
        ['m2', 'body m2'],
      ]);
    });

    it('writes nothing for an empty list', async () => {
      expect(await store.putAttachments(identity, [])).toBe(false);
      expect(await store.load(identity.key)).toBeNull();
    });
  });
});
