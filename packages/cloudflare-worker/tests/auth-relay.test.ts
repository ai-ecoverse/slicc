import { describe, it, expect } from 'vitest';
import { handleWorkerRequest, type WorkerEnv } from '../src/index.js';

const fakeAssets = {
  fetch: async (_req: Request) =>
    new Response('<html><body>SPA</body></html>', {
      headers: { 'content-type': 'text/html' },
    }),
};

const env = { TRAY_HUB: {}, ASSETS: fakeAssets } as unknown as WorkerEnv;

function relayRequest(query: string): Request {
  return new Request(`https://www.sliccy.ai/auth/callback${query}`);
}

async function fetchRelayBody(query: string): Promise<string> {
  const res = await handleWorkerRequest(relayRequest(query), env);
  return res.text();
}

/**
 * Run the inline relay script against a fake `location` and `document` and
 * return what would have been navigated to (or the error text shown to the
 * user). This is the behavioural test seam — the relay's logic lives in the
 * page's <script> tag, not in worker code, so we exercise the script directly.
 */
function runRelay(html: string, search: string, hash = ''): { replaced?: string; error?: string } {
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('No <script> in relay HTML');
  let replaced: string | undefined;
  let errorText: string | undefined;
  const fakeLocation = {
    search,
    hash,
    replace: (url: string) => {
      replaced = url;
    },
  };
  const msgEl = { textContent: '' };
  const fakeDocument = { getElementById: (_id: string) => msgEl };
  const fn = new Function(
    'location',
    'document',
    'btoa',
    'atob',
    'URLSearchParams',
    'JSON',
    'Number',
    match[1]!
  );
  fn(fakeLocation, fakeDocument, btoa, atob, URLSearchParams, JSON, Number);
  if (!replaced && msgEl.textContent.startsWith('OAuth redirect failed: ')) {
    errorText = msgEl.textContent
      .replace(/^OAuth redirect failed: /, '')
      .replace(/\. Close.*$/, '');
  }
  return { replaced, error: errorText };
}

describe('OAuth callback relay — page response', () => {
  it('returns relay HTML for valid state', async () => {
    const state = btoa(JSON.stringify({ port: 5720, path: '/auth/callback', nonce: 'abc123' }));
    const res = await handleWorkerRequest(relayRequest(`?state=${state}`), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('Redirecting');
  });

  it('returns relay HTML even without state (page shows error client-side)', async () => {
    const res = await handleWorkerRequest(relayRequest(''), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('relay page is static and identical regardless of state content', async () => {
    const state1 = btoa(JSON.stringify({ port: 5710, path: '/auth/callback', nonce: 'a' }));
    const state2 = btoa(
      JSON.stringify({
        source: 'extension',
        extensionId: 'akjjllgokmbgpbdbmafpiefnhidlmbgf',
        path: '/github',
        nonce: 'b',
      })
    );
    const res1 = await handleWorkerRequest(relayRequest(`?state=${state1}`), env);
    const res2 = await handleWorkerRequest(relayRequest(`?state=${state2}`), env);
    expect(await res1.text()).toBe(await res2.text());
  });

  it('does not interfere with existing tray routes', async () => {
    const trayReq = new Request('https://www.sliccy.ai/join/some-token');
    const res = await handleWorkerRequest(trayReq, env);
    const body = await res.text();
    expect(body).not.toContain('Redirecting to SLICC');
  });
});

describe('OAuth callback relay — local source (CLI)', () => {
  it('redirects to localhost when no source field is set (back-compat)', async () => {
    const state = btoa(JSON.stringify({ port: 5720, path: '/auth/callback', nonce: 'n1' }));
    const html = await fetchRelayBody(`?state=${state}&code=abc`);
    const { replaced, error } = runRelay(html, `?state=${state}&code=abc`);
    expect(error).toBeUndefined();
    expect(replaced).toMatch(/^http:\/\/localhost:5720\/auth\/callback\?/);
    expect(replaced).toContain('code=abc');
    expect(replaced).toContain('nonce=n1');
    expect(replaced).not.toContain('state=');
  });

  it('redirects to localhost when source is "local"', async () => {
    const state = btoa(
      JSON.stringify({ source: 'local', port: 5710, path: '/auth/callback', nonce: 'n2' })
    );
    const html = await fetchRelayBody(`?state=${state}&code=xyz`);
    const { replaced } = runRelay(html, `?state=${state}&code=xyz`);
    expect(replaced).toMatch(/^http:\/\/localhost:5710\/auth\/callback\?/);
  });

  it('rejects ports below 1024', async () => {
    const state = btoa(JSON.stringify({ port: 80, path: '/auth/callback', nonce: 'n' }));
    const html = await fetchRelayBody(`?state=${state}`);
    const { replaced, error } = runRelay(html, `?state=${state}`);
    expect(replaced).toBeUndefined();
    expect(error).toContain('Invalid port');
  });

  it('rejects ports above 65535', async () => {
    const state = btoa(JSON.stringify({ port: 99999, path: '/auth/callback', nonce: 'n' }));
    const html = await fetchRelayBody(`?state=${state}`);
    const { replaced, error } = runRelay(html, `?state=${state}`);
    expect(replaced).toBeUndefined();
    expect(error).toContain('Invalid port');
  });

  it('rejects paths that do not start with /', async () => {
    const state = btoa(JSON.stringify({ port: 5710, path: 'evil.com/path', nonce: 'n' }));
    const html = await fetchRelayBody(`?state=${state}`);
    const { replaced, error } = runRelay(html, `?state=${state}`);
    expect(replaced).toBeUndefined();
    expect(error).toContain('Invalid path');
  });
});

describe('OAuth callback relay — extension source', () => {
  const validId = 'akjjllgokmbgpbdbmafpiefnhidlmbgf';

  it('redirects to chromiumapp.org for a valid extensionId', async () => {
    const state = btoa(
      JSON.stringify({ source: 'extension', extensionId: validId, path: '/github', nonce: 'n1' })
    );
    const html = await fetchRelayBody(`?state=${state}&code=abc`);
    const { replaced, error } = runRelay(html, `?state=${state}&code=abc`);
    expect(error).toBeUndefined();
    expect(replaced).toMatch(new RegExp(`^https://${validId}\\.chromiumapp\\.org/github\\?`));
    expect(replaced).toContain('code=abc');
    expect(replaced).toContain('nonce=n1');
    expect(replaced).not.toContain('state=');
  });

  it('rejects extensionId with wrong character set (uppercase)', async () => {
    const state = btoa(
      JSON.stringify({
        source: 'extension',
        extensionId: validId.toUpperCase(),
        path: '/github',
        nonce: 'n',
      })
    );
    const html = await fetchRelayBody(`?state=${state}`);
    const { replaced, error } = runRelay(html, `?state=${state}`);
    expect(replaced).toBeUndefined();
    expect(error).toContain('Invalid extensionId');
  });

  it('rejects extensionId with wrong length', async () => {
    const state = btoa(
      JSON.stringify({ source: 'extension', extensionId: 'abc', path: '/github', nonce: 'n' })
    );
    const html = await fetchRelayBody(`?state=${state}`);
    const { replaced, error } = runRelay(html, `?state=${state}`);
    expect(replaced).toBeUndefined();
    expect(error).toContain('Invalid extensionId');
  });

  it('rejects extensionId attempting subdomain injection', async () => {
    // 32 chars total but containing a dot — must fail the strict format check
    const evilId = 'a'.repeat(15) + '.evil' + 'a'.repeat(12);
    expect(evilId.length).toBe(32);
    const state = btoa(
      JSON.stringify({
        source: 'extension',
        extensionId: evilId,
        path: '/github',
        nonce: 'n',
      })
    );
    const html = await fetchRelayBody(`?state=${state}`);
    const { replaced, error } = runRelay(html, `?state=${state}`);
    expect(replaced).toBeUndefined();
    expect(error).toContain('Invalid extensionId');
  });

  it('rejects path that does not start with /', async () => {
    const state = btoa(
      JSON.stringify({
        source: 'extension',
        extensionId: validId,
        path: 'github',
        nonce: 'n',
      })
    );
    const html = await fetchRelayBody(`?state=${state}`);
    const { replaced, error } = runRelay(html, `?state=${state}`);
    expect(replaced).toBeUndefined();
    expect(error).toContain('Invalid path');
  });
});

describe('OAuth callback relay — unknown source', () => {
  it('rejects an unknown source value', async () => {
    const state = btoa(
      JSON.stringify({ source: 'phishing', extensionId: 'x', path: '/x', nonce: 'n' })
    );
    const html = await fetchRelayBody(`?state=${state}`);
    const { replaced, error } = runRelay(html, `?state=${state}`);
    expect(replaced).toBeUndefined();
    expect(error).toContain('Unknown source');
  });
});
