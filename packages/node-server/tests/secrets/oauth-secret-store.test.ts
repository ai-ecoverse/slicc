import { describe, it, expect } from 'vitest';
import { OauthSecretStore } from '../../src/secrets/oauth-secret-store.js';

describe('OauthSecretStore', () => {
  it('set then list returns the entry', () => {
    const store = new OauthSecretStore();
    store.set('oauth.github.token', 'ghp_real', ['github.com']);
    expect(store.list()).toEqual([
      { name: 'oauth.github.token', value: 'ghp_real', domains: ['github.com'] },
    ]);
  });
  it('delete removes the entry', () => {
    const store = new OauthSecretStore();
    store.set('A', '1', ['x.com']);
    store.delete('A');
    expect(store.list()).toEqual([]);
  });
  it('rejects empty domains', () => {
    const store = new OauthSecretStore();
    expect(() => store.set('A', '1', [])).toThrow();
  });
  it('get returns the value or undefined', () => {
    const store = new OauthSecretStore();
    store.set('A', '1', ['x.com']);
    expect(store.get('A')).toBe('1');
    expect(store.get('B')).toBeUndefined();
  });
});
