/**
 * Tests for the session store (IndexedDB persistence).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { SessionStore } from './session-store.js';
import type { ChatMessage, Session } from './types.js';

describe('SessionStore', () => {
  let store: SessionStore;

  beforeEach(async () => {
    // fake-indexeddb/auto provides a fresh indexedDB per import
    store = new SessionStore();
    await store.init();
  });

  it('saves and loads a session', async () => {
    const session: Session = {
      id: 'test-1',
      messages: [{ id: 'm1', role: 'user', content: 'Hello', timestamp: 1000 }],
      createdAt: 1000,
      updatedAt: 1000,
    };

    await store.save(session);
    const loaded = await store.load('test-1');
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe('test-1');
    expect(loaded!.messages).toHaveLength(1);
    expect(loaded!.messages[0].content).toBe('Hello');
  });

  it('returns null for non-existent session', async () => {
    const loaded = await store.load('nonexistent');
    expect(loaded).toBeNull();
  });

  it('upserts on save', async () => {
    const session1: Session = {
      id: 'test-2',
      messages: [{ id: 'm1', role: 'user', content: 'V1', timestamp: 1000 }],
      createdAt: 1000,
      updatedAt: 1000,
    };
    await store.save(session1);

    const session2: Session = {
      id: 'test-2',
      messages: [
        { id: 'm1', role: 'user', content: 'V1', timestamp: 1000 },
        { id: 'm2', role: 'assistant', content: 'V2', timestamp: 2000 },
      ],
      createdAt: 1000,
      updatedAt: 2000,
    };
    await store.save(session2);

    const loaded = await store.load('test-2');
    expect(loaded!.messages).toHaveLength(2);
    expect(loaded!.updatedAt).toBe(2000);
  });

  it('lists sessions sorted by updatedAt descending', async () => {
    // Use unique IDs with high timestamps to ensure they sort first
    await store.save({ id: 'list-old', messages: [], createdAt: 100000, updatedAt: 100000 });
    await store.save({ id: 'list-new', messages: [], createdAt: 200000, updatedAt: 200000 });
    await store.save({ id: 'list-mid', messages: [], createdAt: 150000, updatedAt: 150000 });

    const ids = await store.list();
    // The list may contain sessions from other tests sharing the same DB,
    // so just check that our three appear in the correct relative order.
    const ours = ids.filter((id) => id.startsWith('list-'));
    expect(ours).toEqual(['list-new', 'list-mid', 'list-old']);
  });

  it('deletes a session', async () => {
    await store.save({ id: 'del', messages: [], createdAt: 100, updatedAt: 100 });
    await store.delete('del');
    const loaded = await store.load('del');
    expect(loaded).toBeNull();
  });

  it('saveMessages creates a new session if none exists', async () => {
    const msgs: ChatMessage[] = [{ id: 'm1', role: 'user', content: 'Hello', timestamp: 1000 }];
    await store.saveMessages('auto-1', msgs);

    const loaded = await store.load('auto-1');
    expect(loaded).not.toBeNull();
    expect(loaded!.messages).toHaveLength(1);
  });

  it('saveMessages updates existing session', async () => {
    await store.save({ id: 'upd', messages: [], createdAt: 100, updatedAt: 100 });

    const msgs: ChatMessage[] = [{ id: 'm1', role: 'user', content: 'Updated', timestamp: 2000 }];
    await store.saveMessages('upd', msgs);

    const loaded = await store.load('upd');
    expect(loaded!.messages[0].content).toBe('Updated');
    expect(loaded!.updatedAt).toBeGreaterThan(100);
    expect(loaded!.createdAt).toBe(100); // preserves original createdAt
  });
});
