import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildAuthorizeUrl,
  deriveCodeChallenge,
  exchangeCodeForKey,
  generateCodeVerifier,
  loginIntercepted,
  OPENROUTER_CALLBACK_URL,
  OPENROUTER_REDIRECT_URI_PATTERN,
  parseCallbackCode,
} from '../../providers/openrouter-oauth.js';
import { saveOAuthAccount } from '../../src/ui/provider-settings.js';

vi.mock('../../src/ui/provider-settings.js', () => ({
  saveOAuthAccount: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('OpenRouter PKCE helpers', () => {
  it('derives the RFC 7636 S256 challenge for a fixed verifier', async () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    await expect(deriveCodeChallenge(verifier)).resolves.toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
    );
  });

  it('generates a valid base64url verifier', () => {
    expect(generateCodeVerifier()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('builds the OpenRouter authorize URL', () => {
    const authorize = new URL(buildAuthorizeUrl(OPENROUTER_CALLBACK_URL, 'challenge-value'));
    expect(authorize.origin + authorize.pathname).toBe('https://openrouter.ai/auth');
    expect(authorize.searchParams.get('callback_url')).toBe(OPENROUTER_CALLBACK_URL);
    expect(authorize.searchParams.get('code_challenge')).toBe('challenge-value');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('parses the authorization code and reports callback errors clearly', () => {
    expect(parseCallbackCode(`${OPENROUTER_CALLBACK_URL}?code=abc123`)).toBe('abc123');
    expect(() => parseCallbackCode(null)).toThrow(/cancelled or timed out/i);
    expect(() => parseCallbackCode('not a URL')).toThrow(/invalid callback URL/i);
    expect(() => parseCallbackCode(OPENROUTER_CALLBACK_URL)).toThrow(/authorization code/i);
  });
});

describe('exchangeCodeForKey', () => {
  it('posts the captured code and verifier and returns the permanent key', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(JSON.stringify({ key: 'sk-or-v1-test' }), { status: 200 });
    });

    await expect(exchangeCodeForKey('captured-code', 'pkce-verifier', fetchMock)).resolves.toBe(
      'sk-or-v1-test'
    );
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/v1/auth/keys');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(String(init?.body))).toEqual({
      code: 'captured-code',
      code_verifier: 'pkce-verifier',
      code_challenge_method: 'S256',
    });
  });

  it('includes status and response body in exchange errors', async () => {
    const fetchMock = vi.fn(
      async () => new Response('invalid authorization code', { status: 401 })
    );
    await expect(exchangeCodeForKey('bad', 'verifier', fetchMock)).rejects.toThrow(
      /401.*invalid authorization code/i
    );
  });

  it.each([
    ['invalid JSON', new Response('not-json', { status: 200 }), /invalid JSON/i],
    ['missing key', new Response('{}', { status: 200 }), /empty or invalid API key/i],
    ['non-string key', new Response('{"key":42}', { status: 200 }), /empty or invalid API key/i],
  ])('rejects a response with %s', async (_label, response, expected) => {
    const fetchMock = vi.fn(async () => response);
    await expect(exchangeCodeForKey('code', 'verifier', fetchMock)).rejects.toThrow(expected);
  });
});

describe('loginIntercepted', () => {
  it('captures the loopback callback, exchanges the code, and saves the account', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(JSON.stringify({ key: 'sk-or-v1-permanent' }), { status: 200 })
      )
    );
    const launcher = vi.fn(async (config: { authorizeUrl: string }) => {
      const authorize = new URL(config.authorizeUrl);
      expect(authorize.searchParams.get('code_challenge')).toBeTruthy();
      return `${OPENROUTER_CALLBACK_URL}?code=oauth-code`;
    });
    const onSuccess = vi.fn();

    await loginIntercepted(launcher, onSuccess);

    expect(launcher).toHaveBeenCalledWith({
      authorizeUrl: expect.stringContaining('https://openrouter.ai/auth?'),
      redirectUriPattern: OPENROUTER_REDIRECT_URI_PATTERN,
      onCapture: 'close',
    });
    expect(saveOAuthAccount).toHaveBeenCalledWith({
      providerId: 'openrouter',
      accessToken: 'sk-or-v1-permanent',
      tokenExpiresAt: Number.MAX_SAFE_INTEGER,
      baseUrl: 'https://openrouter.ai/api/v1',
    });
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  it('does not exchange or save when the launcher is cancelled', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(loginIntercepted(async () => null, vi.fn())).rejects.toThrow(
      /cancelled or timed out/i
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(saveOAuthAccount).not.toHaveBeenCalled();
  });
});
