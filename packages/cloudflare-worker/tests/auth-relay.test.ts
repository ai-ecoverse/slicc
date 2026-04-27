import { describe, it, expect } from 'vitest';
import { handleWorkerRequest } from '../src/index.js';

const fakeAssets = {
  fetch: async (_req: Request) =>
    new Response('<html><body>SPA</body></html>', {
      headers: { 'content-type': 'text/html' },
    }),
};

const env = { TRAY_HUB: {}, ASSETS: fakeAssets } as any;

function relayRequest(query: string): Request {
  return new Request(`https://www.sliccy.ai/auth/callback${query}`);
}

describe('OAuth callback relay', () => {
  it('returns relay HTML for valid state', async () => {
    const state = btoa(JSON.stringify({ port: 5720, path: '/auth/callback', nonce: 'abc123' }));
    const res = await handleWorkerRequest(relayRequest(`?state=${state}`), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('localhost');
    expect(body).toContain('Redirecting');
  });

  it('returns relay HTML even without state (page shows error client-side)', async () => {
    const res = await handleWorkerRequest(relayRequest(''), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('relay HTML contains security validation script', async () => {
    const state = btoa(JSON.stringify({ port: 5720, path: '/auth/callback', nonce: 'x' }));
    const res = await handleWorkerRequest(relayRequest(`?state=${state}`), env);
    const body = await res.text();
    expect(body).toContain('port < 1024');
    expect(body).toContain("path.startsWith('/')");
  });

  it('relay page is static and identical regardless of state content', async () => {
    const state1 = btoa(JSON.stringify({ port: 5710, path: '/auth/callback', nonce: 'a' }));
    const state2 = btoa(JSON.stringify({ port: 9999, path: '/auth/github', nonce: 'b' }));
    const res1 = await handleWorkerRequest(relayRequest(`?state=${state1}`), env);
    const res2 = await handleWorkerRequest(relayRequest(`?state=${state2}`), env);
    expect(await res1.text()).toBe(await res2.text());
  });

  it('relay page only redirects to localhost (hardcoded)', async () => {
    const state = btoa(JSON.stringify({ port: 5720, path: '/auth/callback', nonce: 'x' }));
    const res = await handleWorkerRequest(relayRequest(`?state=${state}`), env);
    const body = await res.text();
    // The redirect target is always localhost — not configurable from state
    expect(body).toContain("'http://localhost:'");
    expect(body).not.toContain('https://');
  });

  it('does not interfere with existing tray routes', async () => {
    // /auth/callback is not a capability token route
    const trayReq = new Request('https://www.sliccy.ai/join/some-token');
    const res = await handleWorkerRequest(trayReq, env);
    // Should NOT return relay HTML — should hit the tray token route
    const body = await res.text();
    expect(body).not.toContain('Redirecting to SLICC');
  });
});
