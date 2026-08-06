import { describe, expect, it } from 'vitest';
import { handleWorkerRequest } from '../src/index.js';
import { makeEnv } from './helpers/fake-env.js';

const fakeAssets = {
  fetch: async (_req: Request) =>
    new Response('<html><body>SPA</body></html>', {
      headers: { 'content-type': 'text/html' },
    }),
};

const env = makeEnv({ ASSETS: fakeAssets });

function relayRequest(query: string): Request {
  return new Request(`https://www.sliccy.ai/auth/callback${query}`);
}

function mcpCallbackRequest(query: string): Request {
  return new Request(`https://www.sliccy.ai/auth/mcp-callback${query}`);
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
function runRelay(
  html: string,
  search: string,
  hash = '',
  opts: {
    origin?: string;
    hasOpener?: boolean;
    path?: string;
    noBroadcastChannel?: boolean;
  } = {}
): {
  replaced?: string;
  error?: string;
  postedMessage?: any;
  postedTarget?: string;
  broadcasts: any[];
} {
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('No <script> in relay HTML');
  let replaced: string | undefined;
  let errorText: string | undefined;
  let postedMessage: any;
  let postedTarget: string | undefined;
  const broadcasts: any[] = [];
  const origin = opts.origin ?? 'https://www.sliccy.ai';
  const fakeLocation = {
    search,
    hash,
    origin,
    href: `${origin}${opts.path ?? '/auth/callback'}${search}${hash}`,
    replace: (url: string) => {
      replaced = url;
    },
  };
  const msgEl = { textContent: '' };
  const fakeDocument = { getElementById: (_id: string) => msgEl };
  const fakeOpener = {
    postMessage: (msg: any, targetOrigin: string) => {
      postedMessage = msg;
      postedTarget = targetOrigin;
    },
  };
  const fakeWindow = {
    opener: opts.hasOpener === false ? null : fakeOpener,
    close: () => {
      /* no-op in test */
    },
  };
  // The relay broadcasts on a same-origin channel so a follower whose
  // `window.opener` was severed by COOP still receives the callback.
  class FakeBroadcastChannel {
    constructor(readonly name: string) {
      if (opts.noBroadcastChannel) throw new Error('BroadcastChannel unavailable');
    }
    postMessage(message: unknown): void {
      broadcasts.push({ channel: this.name, message });
    }
    close(): void {
      /* no-op in test */
    }
  }
  const fn = new Function(
    'location',
    'document',
    'window',
    'btoa',
    'atob',
    'URLSearchParams',
    'JSON',
    'Number',
    'setTimeout',
    'BroadcastChannel',
    match[1]!
  );
  fn(
    fakeLocation,
    fakeDocument,
    fakeWindow,
    btoa,
    atob,
    URLSearchParams,
    JSON,
    Number,
    (_fn: any, _ms: number) => {
      /* no-op setTimeout in test */
    },
    FakeBroadcastChannel
  );
  if (!replaced && msgEl.textContent.startsWith('OAuth redirect failed: ')) {
    errorText = msgEl.textContent
      .replace(/^OAuth redirect failed: /, '')
      .replace(/\. Close.*$/, '');
  }
  return { replaced, error: errorText, postedMessage, postedTarget, broadcasts };
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

describe('MCP OAuth callback — opaque state', () => {
  it('posts the callback to the opener without decoding opaque state', async () => {
    const opaqueState = 'mcp-state_opaque~value-123';
    const search = `?code=abc&state=${encodeURIComponent(opaqueState)}`;
    const res = await handleWorkerRequest(mcpCallbackRequest(search), env);

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('atob(');
    const { postedMessage, postedTarget, error } = runRelay(html, search, '', {
      path: '/auth/mcp-callback',
    });

    expect(error).toBeUndefined();
    expect(postedTarget).toBe('https://www.sliccy.ai');
    expect(postedMessage?.type).toBe('oauth-callback');
    const redirect = new URL(postedMessage?.redirectUrl);
    expect(redirect.pathname).toBe('/auth/mcp-callback');
    expect(redirect.searchParams.get('code')).toBe('abc');
    expect(redirect.searchParams.get('state')).toBe(opaqueState);
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

describe('OAuth callback relay — opener source (worker-served SPA)', () => {
  it('postMessages the full callback URL to the opener instead of redirecting', async () => {
    const state = btoa(JSON.stringify({ source: 'opener', path: '/auth/callback', nonce: 'n1' }));
    const search = `?state=${state}`;
    const hash = '#access_token=abc&expires_in=3600&state=' + state;
    const html = await fetchRelayBody(search);
    const { replaced, error, postedMessage, postedTarget } = runRelay(html, search, hash);
    expect(replaced).toBeUndefined();
    expect(error).toBeUndefined();
    expect(postedMessage?.type).toBe('oauth-callback');
    // The delivered URL must carry the IMS hash (access_token lives there) and
    // the nonce in the query so adobe.ts' verifier can read it back.
    expect(postedMessage?.redirectUrl).toContain('#access_token=abc');
    expect(postedMessage?.redirectUrl).toContain('nonce=n1');
    // State is stripped from the query portion (consumer doesn't need it).
    // IMS round-trips state into the hash too — that residue is harmless and
    // preserved as-is so the delivered URL is a complete picture.
    const queryPart = postedMessage.redirectUrl.split('#')[0];
    expect(queryPart).not.toContain('state=');
    // Scoped to the page's own origin (NOT '*') so the token can't leak.
    expect(postedTarget).toBe('https://www.sliccy.ai');
  });

  it('still delivers by broadcast when the opener is gone (COOP-severed popup)', async () => {
    // GitHub serves COOP `same-origin`, which severs `window.opener` for this
    // popup. A follower running a leader-delegated login (#1915) has no
    // loopback result endpoint to fall back on, so the same-origin broadcast
    // is the delivery path that has to work.
    const state = btoa(JSON.stringify({ source: 'opener', path: '/auth/callback', nonce: 'n' }));
    const html = await fetchRelayBody(`?state=${state}&code=abc123`);
    const { replaced, error, broadcasts } = runRelay(html, `?state=${state}&code=abc123`, '', {
      hasOpener: false,
    });
    expect(replaced).toBeUndefined();
    expect(error).toBeUndefined();
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].channel).toBe('slicc-oauth-relay');
    expect(broadcasts[0].message.type).toBe('oauth-callback');
    // The authorization code must survive the relay.
    expect(broadcasts[0].message.redirectUrl).toContain('code=abc123');
    expect(broadcasts[0].message.redirectUrl).toContain('nonce=n');
  });

  it('broadcasts alongside the opener postMessage when both are available', async () => {
    const state = btoa(JSON.stringify({ source: 'opener', path: '/auth/callback', nonce: 'n' }));
    const html = await fetchRelayBody(`?state=${state}&code=abc123`);
    const { postedMessage, broadcasts } = runRelay(html, `?state=${state}&code=abc123`);
    expect(postedMessage?.type).toBe('oauth-callback');
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].message.redirectUrl).toBe(postedMessage.redirectUrl);
  });

  it('errors out when neither the opener nor a broadcast channel is available', async () => {
    const state = btoa(JSON.stringify({ source: 'opener', path: '/auth/callback', nonce: 'n' }));
    const html = await fetchRelayBody(`?state=${state}`);
    const { replaced, error } = runRelay(html, `?state=${state}`, '', {
      hasOpener: false,
      noBroadcastChannel: true,
    });
    expect(replaced).toBeUndefined();
    expect(error).toContain('No opener window');
  });

  it('rejects path that does not start with /', async () => {
    const state = btoa(JSON.stringify({ source: 'opener', path: 'evil.com/x', nonce: 'n' }));
    const html = await fetchRelayBody(`?state=${state}`);
    const { error } = runRelay(html, `?state=${state}`);
    expect(error).toContain('Invalid path');
  });
});

describe('OAuth callback relay — self-origin guard for local source', () => {
  it('diverts to opener postMessage when the local target matches the relay origin', async () => {
    // wrangler dev: page at http://localhost:8787, state.port=8787 → would
    // self-loop the relay. Guard must divert to opener delivery instead.
    const state = btoa(
      JSON.stringify({ source: 'local', port: 8787, path: '/auth/callback', nonce: 'n1' })
    );
    const search = `?state=${state}&code=abc`;
    const html = await fetchRelayBody(search);
    const { replaced, error, postedMessage, postedTarget } = runRelay(html, search, '', {
      origin: 'http://localhost:8787',
    });
    expect(replaced).toBeUndefined();
    expect(error).toBeUndefined();
    expect(postedMessage?.type).toBe('oauth-callback');
    expect(postedMessage?.redirectUrl).toContain('code=abc');
    expect(postedMessage?.redirectUrl).toContain('nonce=n1');
    expect(postedTarget).toBe('http://localhost:8787');
  });

  it('still redirects to localhost when ports differ (harness path: page :8787, bridge :5710)', async () => {
    const state = btoa(
      JSON.stringify({ source: 'local', port: 5710, path: '/auth/callback', nonce: 'n' })
    );
    const html = await fetchRelayBody(`?state=${state}&code=abc`);
    const { replaced, postedMessage } = runRelay(html, `?state=${state}&code=abc`, '', {
      origin: 'http://localhost:8787',
    });
    expect(replaced).toMatch(/^http:\/\/localhost:5710\/auth\/callback\?/);
    expect(postedMessage).toBeUndefined();
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

describe('OAuth callback relay — capture hop (webapp served by worker)', () => {
  // Run the capture page's inline script against fakes; return the posted message.
  function runCapture(html: string, href: string): { postedMessage?: any; postedTarget?: string } {
    const match = html.match(/<script>([\s\S]*?)<\/script>/);
    if (!match) throw new Error('No <script> in capture HTML');
    let postedMessage: any;
    let postedTarget: string | undefined;
    const fakeWindow = {
      opener: {
        postMessage: (msg: any, target: string) => {
          postedMessage = msg;
          postedTarget = target;
        },
      },
      close: () => {
        /* no-op */
      },
    };
    const fn = new Function('window', 'location', 'setTimeout', match[1]!);
    fn(fakeWindow, { href, origin: new URL(href).origin }, (_fn: any) => {
      /* no-op setTimeout */
    });
    return { postedMessage, postedTarget };
  }

  it('serves the capture page when code is present and state is consumed', async () => {
    const res = await handleWorkerRequest(relayRequest('?code=abc&nonce=n1'), env);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Completing sign-in');
    expect(body).not.toContain('Redirecting to SLICC');
  });

  it('serves the capture page for an OAuth error response too', async () => {
    const body = await fetchRelayBody('?error=access_denied&nonce=n');
    expect(body).toContain('Completing sign-in');
  });

  it('capture page postMessages the redirect URL to the opener', async () => {
    const href = 'https://www.sliccy.ai/auth/callback?code=abc&nonce=n1';
    const html = await fetchRelayBody('?code=abc&nonce=n1');
    const { postedMessage, postedTarget } = runCapture(html, href);
    expect(postedMessage).toEqual({ type: 'oauth-callback', redirectUrl: href });
    // Scoped to the page's own origin (NOT '*') so the code can't leak cross-origin.
    expect(postedTarget).toBe('https://www.sliccy.ai');
  });

  it('still serves the relay (not capture) when state is present', async () => {
    const state = btoa(JSON.stringify({ port: 5720, path: '/auth/callback', nonce: 'n' }));
    const body = await fetchRelayBody(`?state=${state}&code=abc`);
    expect(body).toContain('Redirecting to SLICC');
    expect(body).not.toContain('Completing sign-in');
  });
});

describe('OAuth callback relay — error handling', () => {
  it('postMessages error to window.opener on catch', async () => {
    // No state query param → catch block runs
    const html = await fetchRelayBody('');
    const { replaced, error, postedMessage } = runRelay(html, '');
    expect(replaced).toBeUndefined();
    expect(error).toBeTruthy();
    expect(postedMessage).toEqual({ type: 'sliccy.cloud.imsError', error: expect.any(String) });
  });
});
