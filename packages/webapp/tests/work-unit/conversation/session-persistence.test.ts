/**
 * The read-old/write-new window in `SessionPersistence` (#2275).
 *
 * The kill switch is the subject here: every read prefers the canonical
 * record, and EVERY failure mode of the canonical path — no store, no
 * record, an unopenable database, a record that derives to no Pi history —
 * lands on the legacy `agent-sessions` store with the conversation intact.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import type { SessionStore } from '../../../src/core/session.js';
import { SessionPersistence } from '../../../src/scoops/scoop-context/session-persistence.js';
import { entriesFromChatMessages } from '../../../src/work-unit/conversation/entries.js';
import type { ConversationIdentity } from '../../../src/work-unit/conversation/store.js';
import { WorkUnitConversationStore } from '../../../src/work-unit/conversation/store.js';
import { CONVERSATION_RECORD_VERSION } from '../../../src/work-unit/conversation/types.js';
import { legacyAgentMessages, legacyChatMessages } from './fixtures.js';

let dbCounter = 0;

const identity: ConversationIdentity = {
  key: '/workspace::cone_1',
  workUnitId: 'cone_1',
  workspaceId: '/workspace',
  folder: 'cone',
  legacyKeys: { agentSessionId: 'cone_1', chatSessionId: 'session-cone' },
};

/** Minimal in-memory stand-in for the legacy `agent-sessions` store. */
function fakeLegacyStore() {
  const saved = new Map<string, { messages: unknown[]; createdAt: number }>();
  return {
    saved,
    store: {
      save: vi.fn(async (session: { id: string; messages: unknown[]; createdAt: number }) => {
        saved.set(session.id, { messages: session.messages, createdAt: session.createdAt });
      }),
      load: vi.fn(async (id: string) => {
        const found = saved.get(id);
        return found
          ? {
              id,
              messages: found.messages,
              config: {},
              createdAt: found.createdAt,
              updatedAt: found.createdAt,
            }
          : null;
      }),
    } as unknown as SessionStore,
  };
}

describe('SessionPersistence with a canonical record', () => {
  let canonicalStore: WorkUnitConversationStore;

  beforeEach(() => {
    dbCounter++;
    canonicalStore = new WorkUnitConversationStore({ dbName: `test-persistence-${dbCounter}` });
  });

  function build(options: { canonical?: boolean; messages?: unknown[] } = {}) {
    const legacy = fakeLegacyStore();
    const messages = options.messages ?? legacyAgentMessages();
    const persistence = new SessionPersistence({
      store: legacy.store,
      sessionId: 'cone_1',
      folder: 'cone',
      getMessages: () => messages as never,
      isDisposed: () => false,
      onRestoreError: vi.fn(),
      canonical: options.canonical === false ? null : { store: canonicalStore, identity },
    });
    return { persistence, legacy, messages };
  }

  it('writes BOTH stores on one persist', async () => {
    const { persistence, legacy, messages } = build();
    persistence.persistNow();
    await vi.waitFor(async () => {
      expect(legacy.saved.get('cone_1')?.messages).toEqual(messages);
      expect(await canonicalStore.load(identity.key)).not.toBeNull();
    });
  });

  it('restores from the canonical record when there is one', async () => {
    const { persistence, legacy, messages } = build();
    persistence.persistNow();
    await vi.waitFor(async () => expect(await canonicalStore.load(identity.key)).not.toBeNull());

    const restored = await persistence.restore();

    expect(restored).toEqual(messages);
    expect(legacy.store.load).not.toHaveBeenCalled();
  });

  it('falls back to the legacy store when no canonical record exists', async () => {
    const { persistence, legacy, messages } = build();
    legacy.saved.set('cone_1', { messages, createdAt: 5 });

    expect(await persistence.restore()).toEqual(messages);
    expect(legacy.store.load).toHaveBeenCalledWith('cone_1');
  });

  it('falls back when the canonical record derives to no Pi history', async () => {
    const { persistence, legacy, messages } = build();
    legacy.saved.set('cone_1', { messages, createdAt: 5 });
    // A record migrated from the UI projection: real conversation, no Pi
    // messages. Restoring from it would hand the model a reconstruction.
    await canonicalStore.save({
      ...identity,
      version: CONVERSATION_RECORD_VERSION,
      origin: 'ui-projection',
      entries: entriesFromChatMessages(legacyChatMessages()),
      createdAt: 1,
      updatedAt: 1,
    });

    expect(await persistence.restore()).toEqual(messages);
    expect(legacy.store.load).toHaveBeenCalledWith('cone_1');
  });

  it('falls back when the canonical store cannot be read at all', async () => {
    const { persistence, legacy, messages } = build();
    legacy.saved.set('cone_1', { messages, createdAt: 5 });
    vi.spyOn(canonicalStore, 'load').mockRejectedValue(new Error('IndexedDB unavailable'));

    // `load` rejecting is the worst case — the restore must still answer
    // with the user's conversation rather than propagate the failure.
    expect(await persistence.restore()).toEqual(messages);
    expect(legacy.store.load).toHaveBeenCalledWith('cone_1');
  });

  it('behaves exactly as before when no canonical store is wired', async () => {
    const { persistence, legacy, messages } = build({ canonical: false });
    persistence.persistNow();
    await vi.waitFor(() => expect(legacy.saved.get('cone_1')?.messages).toEqual(messages));
    expect(await canonicalStore.listKeys()).toEqual([]);
  });

  it('a canonical write failure never costs the legacy write', async () => {
    const { persistence, legacy, messages } = build();
    vi.spyOn(canonicalStore, 'syncAgentMessages').mockRejectedValue(new Error('quota exceeded'));

    persistence.persistNow();

    await vi.waitFor(() => expect(legacy.saved.get('cone_1')?.messages).toEqual(messages));
  });
});
