import { describe, expect, it } from 'vitest';
import {
  type FetchProxySecretSource,
  previewSecret,
  SecretsPipeline,
  SessionSecretStore,
} from '../src/index.js';

function source(
  entries: { name: string; value: string; domains: string[] }[]
): FetchProxySecretSource {
  return {
    get: async (name) => entries.find((e) => e.name === name)?.value,
    listAll: async () => entries.map((e) => ({ ...e })),
  };
}

describe('SessionSecretStore', () => {
  it('set/get/has/delete round-trip', () => {
    const store = new SessionSecretStore();
    expect(store.has('A')).toBe(false);
    store.set('A', 'val-a', ['api.example.com']);
    expect(store.has('A')).toBe(true);
    expect(store.get('A')).toBe('val-a');
    expect(store.getRecord('A')).toEqual({
      name: 'A',
      value: 'val-a',
      domains: ['api.example.com'],
    });
    expect(store.delete('A')).toBe(true);
    expect(store.has('A')).toBe(false);
  });

  it('setDomains only edits existing entries', () => {
    const store = new SessionSecretStore();
    expect(store.setDomains('missing', ['x'])).toBe(false);
    store.set('A', 'v', ['old']);
    expect(store.setDomains('A', ['new'])).toBe(true);
    expect(store.getRecord('A')?.domains).toEqual(['new']);
  });

  it('listAll returns a defensive copy of domains', () => {
    const store = new SessionSecretStore();
    store.set('A', 'v', ['d1']);
    const all = store.listAll();
    all[0].domains.push('mutated');
    expect(store.getRecord('A')?.domains).toEqual(['d1']);
  });
});

describe('previewSecret', () => {
  it('elides the middle, keeping first/last N chars', () => {
    expect(previewSecret('sk-proj-ABCDEFGH1234')).toBe('sk-p…1234');
  });
  it('always elides at least one character for short values', () => {
    expect(previewSecret('short')).toBe('sh…rt');
    expect(previewSecret('ab')).toBe('…');
    expect(previewSecret('')).toBe('');
  });
});

describe('SecretsPipeline + SessionSecretStore', () => {
  it('unmasks session secrets layered onto the source', async () => {
    const sessionStore = new SessionSecretStore();
    sessionStore.set('SESSION_TOKEN', 'sess_realValue', ['api.session.com']);
    const pipeline = new SecretsPipeline({
      sessionId: 'fixed',
      source: source([]),
      sessionStore,
    });
    await pipeline.reload();

    const masked = await pipeline.maskOne('SESSION_TOKEN', 'sess_realValue');
    const headers: Record<string, string> = { authorization: `Bearer ${masked}` };
    const result = pipeline.unmaskHeaders(headers, 'api.session.com');
    expect(result.forbidden).toBeUndefined();
    expect(headers.authorization).toBe('Bearer sess_realValue');
  });

  it('persisted secrets win on a name collision with session secrets', async () => {
    const sessionStore = new SessionSecretStore();
    sessionStore.set('TOKEN', 'session-shadow', ['*']);
    const pipeline = new SecretsPipeline({
      sessionId: 'fixed',
      source: source([{ name: 'TOKEN', value: 'persisted-real', domains: ['api.example.com'] }]),
      sessionStore,
    });
    await pipeline.reload();

    const entries = pipeline.getMaskedEntries();
    const tokenEntries = entries.filter((e) => e.name === 'TOKEN');
    expect(tokenEntries).toHaveLength(1);
    expect(tokenEntries[0].domains).toEqual(['api.example.com']);
  });

  it('session secrets added after construction appear after reload()', async () => {
    const sessionStore = new SessionSecretStore();
    const pipeline = new SecretsPipeline({ sessionId: 'fixed', source: source([]), sessionStore });
    await pipeline.reload();
    expect(pipeline.hasSecrets()).toBe(false);

    sessionStore.set('LATE', 'late-value', ['late.example.com']);
    await pipeline.reload();
    expect(pipeline.getMaskedEntries().map((e) => e.name)).toContain('LATE');
  });
});
