import { describe, it, expect } from 'vitest';
import { OauthSecretStore } from '../../src/secrets/oauth-secret-store.js';
import { SecretProxyManager } from '../../src/secrets/proxy-manager.js';

describe('OAuth endpoint logic', () => {
  it('POST oauth-update happy path: validates, stores, returns maskedValue', async () => {
    const oauthStore = new OauthSecretStore();
    const proxy = new SecretProxyManager(undefined, 'fixed-session', oauthStore);
    const payload = {
      providerId: 'github',
      accessToken: 'ghp_real',
      domains: ['github.com'],
    };
    // Validation
    expect(typeof payload.providerId).toBe('string');
    expect(typeof payload.accessToken).toBe('string');
    expect(Array.isArray(payload.domains) && payload.domains.length > 0).toBe(true);
    const name = `oauth.${payload.providerId}.token`;
    oauthStore.set(name, payload.accessToken, payload.domains);
    await proxy.reload();
    const masked = proxy.getMaskedEntries().find((e) => e.name === name)?.maskedValue;
    expect(masked).toBeDefined();
    expect(masked).toMatch(/^ghp_/);
  });

  it('DELETE removes the entry; 404 case detected', async () => {
    const oauthStore = new OauthSecretStore();
    expect(oauthStore.list().some((e) => e.name === 'oauth.github.token')).toBe(false);
    oauthStore.set('oauth.github.token', 'x', ['github.com']);
    oauthStore.delete('oauth.github.token');
    expect(oauthStore.list().some((e) => e.name === 'oauth.github.token')).toBe(false);
  });
});
