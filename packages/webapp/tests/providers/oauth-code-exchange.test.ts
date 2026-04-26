import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Stub localStorage
const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => store.set(key, value),
  removeItem: (key: string) => store.delete(key),
});

// Stub fetch
const mockFetch = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', mockFetch);

// Import after stubs are in place
const { exchangeOAuthCode, revokeOAuthToken } =
  await import('../../src/providers/oauth-code-exchange.js');

beforeEach(() => {
  store.clear();
  mockFetch.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('exchangeOAuthCode', () => {
  it('calls the worker /oauth/token endpoint with the correct payload', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: 'gho_abc123',
          token_type: 'bearer',
          scope: 'repo',
        }),
        { status: 200 }
      )
    );

    const result = await exchangeOAuthCode({
      provider: 'github',
      code: 'test-code',
      redirectUri: 'https://www.sliccy.ai/auth/callback',
    });

    expect(result.access_token).toBe('gho_abc123');
    expect(result.token_type).toBe('bearer');
    expect(result.scope).toBe('repo');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://www.sliccy.ai/oauth/token');
    expect(init?.method).toBe('POST');
    const body = JSON.parse(init?.body as string);
    expect(body).toEqual({
      provider: 'github',
      code: 'test-code',
      redirect_uri: 'https://www.sliccy.ai/auth/callback',
    });
  });

  it('uses the stored worker base URL when available', async () => {
    store.set('slicc.trayWorkerBaseUrl', 'https://staging.example.com');

    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 })
    );

    await exchangeOAuthCode({ provider: 'github', code: 'c', redirectUri: 'r' });

    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://staging.example.com/oauth/token');
  });

  it('throws on OAuth error response (error field in 200 body)', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: 'bad_verification_code',
          error_description: 'The code is expired.',
        }),
        { status: 200 }
      )
    );

    await expect(
      exchangeOAuthCode({ provider: 'github', code: 'bad', redirectUri: 'r' })
    ).rejects.toThrow('The code is expired.');
  });

  it('throws on HTTP error response', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: 'server_error',
          error_description: 'Not configured',
        }),
        { status: 501 }
      )
    );

    await expect(
      exchangeOAuthCode({ provider: 'github', code: 'c', redirectUri: 'r' })
    ).rejects.toThrow('Not configured');
  });

  it('throws with useful message on non-JSON response', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response('<html>Bad Gateway</html>', {
        status: 502,
        headers: { 'content-type': 'text/html' },
      })
    );

    await expect(
      exchangeOAuthCode({ provider: 'github', code: 'c', redirectUri: 'r' })
    ).rejects.toThrow('non-JSON response');
  });
});

describe('revokeOAuthToken', () => {
  it('calls the worker /oauth/revoke endpoint', async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await revokeOAuthToken({ provider: 'github', accessToken: 'gho_tok' });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://www.sliccy.ai/oauth/revoke');
    expect(init?.method).toBe('POST');
    const body = JSON.parse(init?.body as string);
    expect(body).toEqual({ provider: 'github', access_token: 'gho_tok' });
  });

  it('does not throw for unsupported revocation (400 + unsupported error)', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'unsupported', error_description: 'Not supported' }), {
        status: 400,
      })
    );

    await expect(
      revokeOAuthToken({ provider: 'github', accessToken: 'tok' })
    ).resolves.toBeUndefined();
  });

  it('throws on unexpected server errors', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Internal Server Error', { status: 500 }));

    await expect(revokeOAuthToken({ provider: 'github', accessToken: 'tok' })).rejects.toThrow(
      'Token revocation failed (HTTP 500)'
    );
  });
});
