import { describe, expect, it, vi } from 'vitest';
import { OauthSecretStore } from '../src/secrets/oauth-secret-store.js';
import { registerSecretsReloadEndpoint } from '../src/secrets-reload-endpoint.js';

describe('POST /api/secrets/reload', () => {
  it('registers a loopback route that calls secretProxy.reload() and returns {ok:true}', async () => {
    const reload = vi.fn().mockResolvedValue(undefined);
    const secretStore = { list: () => [] } as never;
    const oauthStore = new OauthSecretStore();
    let handler: ((req: unknown, res: { json: (b: unknown) => void }) => Promise<void>) | undefined;
    const app = {
      post: (path: string, _mw: unknown, h: typeof handler) => {
        if (path === '/api/secrets/reload') handler = h;
      },
    };
    registerSecretsReloadEndpoint(app as never, {
      secretProxy: { reload },
      secretStore,
      oauthStore,
    });
    expect(handler).toBeTypeOf('function');
    const json = vi.fn();
    await handler!({}, { json });
    expect(reload).toHaveBeenCalledOnce();
    expect(json).toHaveBeenCalledWith({ ok: true });
  });

  it('clears OAuth store entries that collide with env file entries on reload', async () => {
    const reload = vi.fn().mockResolvedValue(undefined);
    const secretStore = {
      list: () => [
        { name: 'oauth.github.token', domains: ['github.com'] },
        { name: 'SOME_OTHER_SECRET', domains: ['example.com'] },
      ],
    } as never;
    const oauthStore = new OauthSecretStore();
    oauthStore.set('oauth.github.token', 'stale-token', ['github.com']);
    oauthStore.set('oauth.adobe.token', 'keep-this', ['adobe.com']);

    let handler: ((req: unknown, res: { json: (b: unknown) => void }) => Promise<void>) | undefined;
    const app = {
      post: (path: string, _mw: unknown, h: typeof handler) => {
        if (path === '/api/secrets/reload') handler = h;
      },
    };
    registerSecretsReloadEndpoint(app as never, {
      secretProxy: { reload },
      secretStore,
      oauthStore,
    });

    const json = vi.fn();
    await handler!({}, { json });

    expect(oauthStore.get('oauth.github.token')).toBeUndefined();
    expect(oauthStore.get('oauth.adobe.token')).toBe('keep-this');
    expect(reload).toHaveBeenCalledOnce();
  });
});
