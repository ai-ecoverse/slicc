import { describe, expect, it, vi } from 'vitest';
import { registerSecretsReloadEndpoint } from '../src/secrets-reload-endpoint.js';

describe('POST /api/secrets/reload', () => {
  it('registers a loopback route that calls secretProxy.reload() and returns {ok:true}', async () => {
    const reload = vi.fn().mockResolvedValue(undefined);
    let handler: ((req: unknown, res: { json: (b: unknown) => void }) => Promise<void>) | undefined;
    const app = {
      post: (path: string, _mw: unknown, h: typeof handler) => {
        if (path === '/api/secrets/reload') handler = h;
      },
    };
    registerSecretsReloadEndpoint(app as never, { secretProxy: { reload } });
    expect(handler).toBeTypeOf('function');
    const json = vi.fn();
    await handler!({}, { json });
    expect(reload).toHaveBeenCalledOnce();
    expect(json).toHaveBeenCalledWith({ ok: true });
  });
});
