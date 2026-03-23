import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { SessionStore } from './session.js';
import type { SessionData } from './types.js';

describe('SessionStore', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore();
  });

  it('generates unique session IDs', () => {
    const id1 = SessionStore.newId();
    const id2 = SessionStore.newId();
    expect(id1).not.toBe(id2);
    expect(id1).toMatch(/^session-/);
  });

  it('creates a session with defaults', () => {
    const session = SessionStore.createSession('test-1', {
      model: 'claude-opus-4-6',
    });
    expect(session.id).toBe('test-1');
    expect(session.messages).toEqual([]);
    expect(session.createdAt).toBeGreaterThan(0);
    expect(session.updatedAt).toBeGreaterThan(0);
  });

  it('saves and loads a session', async () => {
    const session = SessionStore.createSession('s1', {
      model: 'claude-opus-4-6',
    });
    session.messages = [{ role: 'user', content: 'hello', timestamp: Date.now() }];

    await store.save(session);
    const loaded = await store.load('s1');
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe('s1');
    expect(loaded!.messages).toHaveLength(1);
    expect(loaded!.messages[0].role).toBe('user');
    expect((loaded!.messages[0] as any).content).toBe('hello');
  });

  it('returns null for non-existent session', async () => {
    const loaded = await store.load('nonexistent');
    expect(loaded).toBeNull();
  });

  it('deletes a session', async () => {
    const session = SessionStore.createSession('s2', {});
    await store.save(session);
    await store.delete('s2');
    const loaded = await store.load('s2');
    expect(loaded).toBeNull();
  });

  it('lists sessions', async () => {
    await store.save(SessionStore.createSession('list-a', {}));
    await store.save(SessionStore.createSession('list-b', {}));
    const list = await store.list();
    // Other tests may write to the same DB, so filter to our entries
    const ours = list.filter((s) => s.id.startsWith('list-'));
    expect(ours).toHaveLength(2);
    expect(ours.map((s) => s.id).sort()).toEqual(['list-a', 'list-b']);
  });

  it('updates session messages', () => {
    const session = SessionStore.createSession('u1', {});
    const updated = SessionStore.updateMessages(session, [
      { role: 'user', content: 'hi', timestamp: Date.now() },
    ]);
    expect(updated.messages).toHaveLength(1);
    expect(updated.updatedAt).toBeGreaterThanOrEqual(session.updatedAt);
    // Original is unchanged
    expect(session.messages).toHaveLength(0);
  });

  it('clears all sessions', async () => {
    await store.save(SessionStore.createSession('clear-a', {}));
    await store.save(SessionStore.createSession('clear-b', {}));
    await store.clearAll();
    const list = await store.list();
    const ours = list.filter((s) => s.id.startsWith('clear-'));
    expect(ours).toHaveLength(0);
  });

  it('overwrites an existing session', async () => {
    const session = SessionStore.createSession('ow', {});
    session.messages = [{ role: 'user', content: 'first', timestamp: Date.now() }];
    await store.save(session);

    session.messages = [{ role: 'user', content: 'second', timestamp: Date.now() }];
    await store.save(session);

    const loaded = await store.load('ow');
    expect(loaded!.messages).toHaveLength(1);
    expect((loaded!.messages[0] as any).content).toBe('second');
  });
});
