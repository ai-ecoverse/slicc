import { describe, expect, it } from 'vitest';
import { handleBridgeRoute } from '../src/preview-handler.js';

function fakeStub() {
  const calls: Request[] = [];
  return {
    calls,
    fetch: async (request: Request) => {
      calls.push(request);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  };
}

const origin = 'https://tok--sec.sliccy.now';
const token = 'tray.secret';

describe('handleBridgeRoute', () => {
  it('serves the bootstrap JS same-origin without touching the DO', async () => {
    const stub = fakeStub();
    const url = new URL(`${origin}/__slicc/preview-bridge.js`);
    const res = await handleBridgeRoute(new Request(url), url, stub, token);
    expect(res).not.toBeNull();
    expect(res!.headers.get('content-type')).toMatch(/javascript/);
    expect(await res!.text()).toContain('__slicc');
    expect(stub.calls).toHaveLength(0);
  });

  it('forwards /__slicc/emit POST to the DO with the preview token', async () => {
    const stub = fakeStub();
    const url = new URL(`${origin}/__slicc/emit`);
    const res = await handleBridgeRoute(
      new Request(url, { method: 'POST', body: '{"name":"x"}' }),
      url,
      stub,
      token
    );
    expect(res!.status).toBeLessThan(500);
    expect(stub.calls.map((r) => new URL(r.url).pathname)).toEqual(['/internal/preview/emit']);
    await expect(stub.calls[0]!.json()).resolves.toEqual({
      previewToken: token,
      body: '{"name":"x"}',
    });
  });

  it('forwards the bridge WebSocket upgrade to the DO unchanged', async () => {
    const stub = fakeStub();
    const url = new URL(`${origin}/__slicc/bridge`);
    const request = new Request(url, { headers: { upgrade: 'websocket' } });
    await handleBridgeRoute(request, url, stub, token);
    expect(stub.calls).toEqual([request]);
  });

  it('returns null for a normal preview path and a non-upgrade bridge GET', async () => {
    const stub = fakeStub();
    for (const path of ['/index.html', '/__slicc/bridge']) {
      const url = new URL(`${origin}${path}`);
      expect(await handleBridgeRoute(new Request(url), url, stub, token)).toBeNull();
    }
    expect(stub.calls).toHaveLength(0);
  });
});
