import { describe, expect, it } from 'vitest';
import { handleBridgeRoute } from '../src/preview-bridge-routes.js';
import type { DurableObjectIdLike, DurableObjectNamespaceLike } from '../src/shared.js';

interface FakeEnv {
  TRAY_HUB: DurableObjectNamespaceLike;
  stubCalls: string[];
}

function fakeEnv(): FakeEnv {
  const stubCalls: string[] = [];
  const fakeStub = {
    fetch: async (input: Request | string | URL) => {
      const url =
        typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
      stubCalls.push(url);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  };

  return {
    TRAY_HUB: {
      idFromName: (name: string): DurableObjectIdLike => ({
        toString: () => name,
      }),
      get: () => fakeStub,
    },
    stubCalls,
  };
}

describe('preview-bridge-routes', () => {
  const token = 'tray.secret';

  it('serves the bootstrap JS same-origin', async () => {
    const res = await handleBridgeRoute(
      new Request('https://tok--sec.sliccy.now/__slicc/preview-bridge.js'),
      new URL('https://tok--sec.sliccy.now/__slicc/preview-bridge.js'),
      fakeEnv(),
      token
    );
    expect(res).not.toBeNull();
    expect(res!.headers.get('content-type')).toMatch(/javascript/);
    expect(await res!.text()).toContain('__slicc');
  });

  it('forwards /__slicc/emit POST to the DO', async () => {
    const env = fakeEnv();
    const res = await handleBridgeRoute(
      new Request('https://tok--sec.sliccy.now/__slicc/emit', {
        method: 'POST',
        body: '{"name":"x"}',
      }),
      new URL('https://tok--sec.sliccy.now/__slicc/emit'),
      env,
      token
    );
    expect(res!.status).toBeLessThan(500);
    expect(env.stubCalls.some((u) => u.includes('/internal/preview/emit'))).toBe(true);
  });

  it('returns null for a normal preview path', async () => {
    const res = await handleBridgeRoute(
      new Request('https://tok--sec.sliccy.now/index.html'),
      new URL('https://tok--sec.sliccy.now/index.html'),
      fakeEnv(),
      token
    );
    expect(res).toBeNull();
  });
});
