import { describe, it, expect } from 'vitest';
import { handleWorkerRequest } from '../src/index.js';

const env = { TRAY_HUB: {} } as any;

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
});
