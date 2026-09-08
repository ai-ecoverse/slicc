/**
 * Coverage for Adobe's upstream token check (`oauth-token adobe --check`) and
 * for the IMS profile endpoint an account's display name comes from (#2929).
 *
 * Why the check exists: a stored Adobe token well inside its recorded 24h
 * expiry says nothing about whether IMS still honours it. Before
 * `onValidateToken`, `--check adobe` could only answer "cannot be checked
 * upstream", so a healthy token and a revoked one looked identical from the
 * outside and both ended at a `--force-login` popup.
 *
 * The load-bearing detail these tests pin: `/ims/validate_token/v1` answers
 * **HTTP 200 for both verdicts** and puts the verdict in the body. Reading the
 * status as the answer would call every revoked token valid.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const oauthServiceMocks = vi.hoisted(() => ({
  createOAuthLauncher: vi.fn(),
  getOAuthPageOrigin: vi.fn(),
}));

vi.mock('../../src/providers/oauth-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/providers/oauth-service.js')>();
  return { ...actual, ...oauthServiceMocks };
});

const storage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => storage.set(k, v),
  removeItem: (k: string) => storage.delete(k),
  get length() {
    return storage.size;
  },
  key: (i: number) => [...storage.keys()][i] ?? null,
  clear: () => storage.clear(),
});

const IMS_VALIDATE_URL = 'https://ims-na1.adobelogin.com/ims/validate_token/v1';

/** An IMS-shaped access token. Only the `client_id` claim is ever read back. */
function imsToken(clientId = 'ims-client'): string {
  const payload = Buffer.from(JSON.stringify({ client_id: clientId })).toString('base64url');
  return `header.${payload}.signature`;
}

function seedAdobeAccount(account: {
  accessToken?: string;
  userName?: string;
  /** Overrides the build-time proxy endpoint, and keys `proxyConfigCache`. */
  baseUrl?: string;
}): void {
  storage.set('slicc_accounts', JSON.stringify([{ providerId: 'adobe', apiKey: '', ...account }]));
}

/** A fetch stub whose recorded calls stay typed, so `init` is inspectable. */
function stubFetch(
  answer: (url: string) => Response
): ReturnType<typeof vi.fn<(url: unknown, init?: RequestInit) => Promise<Response>>> {
  const spy = vi.fn(async (url: unknown, _init?: RequestInit) => answer(String(url)));
  globalThis.fetch = spy as unknown as typeof globalThis.fetch;
  return spy;
}

/**
 * Route by URL rather than answering everything alike.
 *
 * `--check` asks the account's proxy for `/v1/config` before it asks IMS, so a
 * stub that answers both with the same body makes the verdict call's position
 * in the call list depend on whether `proxyConfigCache` was already warm — and
 * therefore on test order. Naming the two endpoints separately keeps each
 * assertion about the call it means.
 */
function stubImsFetch(answers: {
  config?: Response | (() => Response);
  validate: Response | (() => Response);
}): ReturnType<typeof vi.fn<(url: unknown, init?: RequestInit) => Promise<Response>>> {
  const pick = (a: Response | (() => Response)) => (typeof a === 'function' ? a() : a);
  return stubFetch((url) => {
    if (url.includes('/v1/config')) {
      return answers.config
        ? pick(answers.config)
        : new Response(JSON.stringify({}), { status: 200 });
    }
    if (url.includes('/ims/validate_token/v1')) return pick(answers.validate);
    return new Response('unexpected', { status: 500 });
  });
}

/** The `validate_token` call, found by URL so config calls cannot shift it. */
function validateCall(
  spy: ReturnType<typeof vi.fn<(url: unknown, init?: RequestInit) => Promise<Response>>>
): [url: unknown, init?: RequestInit] | undefined {
  return spy.mock.calls.find((c) => String(c[0]).includes('/ims/validate_token/v1'));
}

/**
 * Route `/v1/config` and `/ims/revoke` separately, same reasoning as
 * {@link stubImsFetch}: logout asks the account's proxy for `/v1/config`
 * before it asks IMS to revoke, and answering both alike would make the
 * revoke call's position depend on whether `proxyConfigCache` was warm.
 */
function stubRevokeFetch(answers: {
  config?: Response | (() => Response);
  revoke?: Response | (() => Response);
}): ReturnType<typeof vi.fn<(url: unknown, init?: RequestInit) => Promise<Response>>> {
  const pick = (a: Response | (() => Response)) => (typeof a === 'function' ? a() : a);
  return stubFetch((url) => {
    if (url.includes('/v1/config')) {
      return answers.config
        ? pick(answers.config)
        : new Response(JSON.stringify({}), { status: 200 });
    }
    if (url.includes('/ims/revoke')) {
      return answers.revoke ? pick(answers.revoke) : new Response('', { status: 200 });
    }
    return new Response('unexpected', { status: 500 });
  });
}

/** The `/ims/revoke` call, found by URL so config calls cannot shift it. */
function revokeCall(
  spy: ReturnType<typeof vi.fn<(url: unknown, init?: RequestInit) => Promise<Response>>>
): [url: unknown, init?: RequestInit] | undefined {
  return spy.mock.calls.find((c) => String(c[0]).includes('/ims/revoke'));
}

/** Read the Adobe account back out of storage after a logout. */
async function readAdobeAccount(): Promise<{ accessToken?: string } | undefined> {
  const { getAccounts } = await import('../../src/ui/provider-settings.js');
  return getAccounts().find((a) => a.providerId === 'adobe');
}

/** The request `onValidateToken` sent, decoded from the form body. */
function sentForm(init: RequestInit | undefined): URLSearchParams {
  return new URLSearchParams(String(init?.body));
}

describe('adobe onValidateToken (does IMS still accept the token?)', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    storage.clear();
    vi.clearAllMocks();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('reports accepted when IMS answers valid, naming the stored identity', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ valid: true }), { status: 200 })
    ) as typeof globalThis.fetch;
    seedAdobeAccount({ accessToken: imsToken(), userName: 'Lars Trieloff' });

    const { config } = await import('../../providers/adobe.js');
    await expect(config.onValidateToken?.()).resolves.toEqual({
      status: 'accepted',
      userName: 'Lars Trieloff',
    });
  });

  it('asks the endpoint built for the question, with the token’s own client_id', async () => {
    const fetchSpy = stubImsFetch({
      validate: () => new Response(JSON.stringify({ valid: true }), { status: 200 }),
    });
    const token = imsToken('experience-catalyst-prod');
    seedAdobeAccount({ accessToken: token });

    const { config } = await import('../../providers/adobe.js');
    await config.onValidateToken?.();

    const call = validateCall(fetchSpy);
    expect(call?.[0]).toBe(IMS_VALIDATE_URL);
    const form = sentForm(call?.[1]);
    expect(form.get('token')).toBe(token);
    expect(form.get('type')).toBe('access_token');
    // Read back from the JWT rather than the proxy config: the token's own
    // claim is the client the question is about, and it needs no network call,
    // so the check still works when /v1/config is unreachable. IMS answers 400
    // when `client_id` is missing, which would make that case report UNKNOWN.
    expect(form.get('client_id')).toBe('experience-catalyst-prod');
  });

  it('treats a 200 with no boolean verdict as unknown, not a refusal', async () => {
    // An IMS error envelope or a truncated body can arrive with HTTP 200.
    // Falling through to `rejected` there would claim IMS refused a credential
    // it never ruled on, and push the caller into a consent window that cannot
    // fix anything (#2939 review).
    for (const body of [
      { error: 'server_error' },
      { valid: 'true' },
      { valid: null },
      {},
    ] as const) {
      stubImsFetch({ validate: () => new Response(JSON.stringify(body), { status: 200 }) });
      seedAdobeAccount({ accessToken: imsToken() });

      const { config } = await import('../../providers/adobe.js');
      const result = await config.onValidateToken?.();
      expect(result?.status, JSON.stringify(body)).toBe('unknown');
    }
  });

  it('asks the IMS environment the account’s own proxy names, not the first cached one', async () => {
    // `proxyConfigCache` is keyed by endpoint, so reading the first value out of
    // it returns whichever proxy was fetched first this session, and on a cold
    // page returns nothing — silently falling back to PRODUCTION IMS. For a
    // stg1 account that asks an IMS which never minted the token (#2939
    // review). A distinct `baseUrl` also gives this test its own cache key.
    const fetchSpy = stubImsFetch({
      config: () =>
        new Response(JSON.stringify({ imsEnvironment: 'stg1', clientId: 'stg-client' }), {
          status: 200,
        }),
      validate: () => new Response(JSON.stringify({ valid: true }), { status: 200 }),
    });
    seedAdobeAccount({ accessToken: imsToken(), baseUrl: 'https://adobe-proxy.stg1.test' });

    const { config } = await import('../../providers/adobe.js');
    await expect(config.onValidateToken?.()).resolves.toMatchObject({ status: 'accepted' });

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://adobe-proxy.stg1.test/v1/config',
      expect.anything()
    );
    expect(validateCall(fetchSpy)?.[0]).toBe(
      'https://ims-na1-stg1.adobelogin.com/ims/validate_token/v1'
    );
  });

  it('still answers when the proxy config lookup fails', async () => {
    // The config call is best-effort: a dead proxy must degrade to the
    // build-time defaults, not stop `--check` from reaching IMS at all.
    const fetchSpy = stubFetch((url) => {
      if (url.includes('/v1/config')) throw new Error('proxy down');
      return new Response(JSON.stringify({ valid: true }), { status: 200 });
    });
    seedAdobeAccount({ accessToken: imsToken(), baseUrl: 'https://adobe-proxy.dead.test' });

    const { config } = await import('../../providers/adobe.js');
    await expect(config.onValidateToken?.()).resolves.toMatchObject({ status: 'accepted' });
    expect(validateCall(fetchSpy)?.[0]).toBe(IMS_VALIDATE_URL);
  });

  it('reads the verdict from the body — IMS answers 200 for a dead token too', async () => {
    // The whole point of the hook. A revoked token comes back 200 with
    // `valid: false`; treating the status as the answer would call it good.
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ valid: false, reason: 'bad_signature' }), { status: 200 })
    ) as typeof globalThis.fetch;
    seedAdobeAccount({ accessToken: imsToken() });

    const { config } = await import('../../providers/adobe.js');
    const result = await config.onValidateToken?.();
    expect(result?.status).toBe('rejected');
    expect(result?.detail).toContain('bad_signature');
  });

  it('still rejects when IMS declines to say why', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ valid: false }), { status: 200 })
    ) as typeof globalThis.fetch;
    seedAdobeAccount({ accessToken: imsToken() });

    const { config } = await import('../../providers/adobe.js');
    const result = await config.onValidateToken?.();
    expect(result?.status).toBe('rejected');
    expect(result?.detail).toContain('no reason given');
  });

  it('never calls a malformed request a rejection', async () => {
    // A 400 is the check failing, not IMS refusing the credential. Reporting
    // `rejected` here would send a caller with a perfectly good token through
    // a consent window that cannot fix anything.
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'bad_request' }), {
          status: 400,
          statusText: 'Bad Request',
        })
    ) as typeof globalThis.fetch;
    seedAdobeAccount({ accessToken: imsToken() });

    const { config } = await import('../../providers/adobe.js');
    await expect(config.onValidateToken?.()).resolves.toEqual({
      status: 'unknown',
      detail: 'HTTP 400 Bad Request',
    });
  });

  it('reports unknown when the call itself fails', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('Failed to fetch');
    }) as unknown as typeof globalThis.fetch;
    seedAdobeAccount({ accessToken: imsToken() });

    const { config } = await import('../../providers/adobe.js');
    await expect(config.onValidateToken?.()).resolves.toEqual({
      status: 'unknown',
      detail: 'Failed to fetch',
    });
  });

  it('reports unknown without calling IMS when nothing is stored', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    seedAdobeAccount({});

    const { config } = await import('../../providers/adobe.js');
    await expect(config.onValidateToken?.()).resolves.toEqual({
      status: 'unknown',
      detail: 'no stored token',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('bounds the call so --check always answers', async () => {
    const fetchSpy = stubImsFetch({
      validate: () => new Response(JSON.stringify({ valid: true }), { status: 200 }),
    });
    seedAdobeAccount({ accessToken: imsToken() });

    const { config } = await import('../../providers/adobe.js');
    await config.onValidateToken?.();

    // Without a signal, a stalled IMS would hang the command forever and the
    // caller would get neither a verdict nor an exit code.
    expect(validateCall(fetchSpy)?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('adobe onOAuthLogout (revokes against the token’s own IMS)', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalWindow: unknown;
  let originalDocument: unknown;

  beforeEach(() => {
    storage.clear();
    vi.clearAllMocks();
    originalFetch = globalThis.fetch;
    // The unconditional local clear at the end of logout writes via
    // `saveOAuthAccount`, which persists straight to `localStorage` only when a
    // DOM is present (otherwise it looks for a panel-RPC bridge). Give it one.
    originalWindow = (globalThis as { window?: unknown }).window;
    originalDocument = (globalThis as { document?: unknown }).document;
    (globalThis as { window?: unknown }).window = {
      location: { origin: 'http://localhost:5710', href: 'http://localhost:5710/' },
    };
    (globalThis as { document?: unknown }).document = {};
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = originalWindow;
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else (globalThis as { document?: unknown }).document = originalDocument;
  });

  it('revokes at the IMS environment the account’s own proxy names, not the first cached one', async () => {
    // Same defect class the #2939 P2 fix repaired for --check, here for a
    // security operation: reading the first value out of `proxyConfigCache`
    // returns whichever endpoint was fetched first this session, and on a cold
    // page (e.g. after a reload) returns nothing — silently falling back to the
    // PRODUCTION IMS host. For a stg1 account the revoke POST then hit an IMS
    // which never minted the token, so IMS refused it (warning only) and the
    // access token stayed valid upstream while logout looked successful. Ask
    // the account's OWN endpoint instead. A distinct `baseUrl` keys its own
    // cache so this stays independent of test order.
    const fetchSpy = stubRevokeFetch({
      config: () =>
        new Response(JSON.stringify({ imsEnvironment: 'stg1', clientId: 'stg-client' }), {
          status: 200,
        }),
    });
    seedAdobeAccount({
      accessToken: imsToken('stg-token-client'),
      baseUrl: 'https://adobe-proxy.logout-stg1.test',
    });

    const { config } = await import('../../providers/adobe.js');
    await config.onOAuthLogout?.();

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://adobe-proxy.logout-stg1.test/v1/config',
      expect.anything()
    );
    expect(revokeCall(fetchSpy)?.[0]).toBe('https://ims-na1-stg1.adobelogin.com/ims/revoke');
    // And the token is gone from storage regardless.
    expect((await readAdobeAccount())?.accessToken).toBe('');
  });

  it('revokes with the token’s own client_id claim, not the proxy config’s', async () => {
    // The revoke must carry the client the token was minted for — the token's
    // own `client_id` claim — or IMS will not honour it. It needs no network
    // call and wins over the proxy config, mirroring `validateAdobeToken`.
    const fetchSpy = stubRevokeFetch({
      config: () => new Response(JSON.stringify({ clientId: 'proxy-client' }), { status: 200 }),
    });
    const token = imsToken('experience-catalyst-prod');
    seedAdobeAccount({ accessToken: token, baseUrl: 'https://adobe-proxy.logout-claim.test' });

    const { config } = await import('../../providers/adobe.js');
    await config.onOAuthLogout?.();

    const form = sentForm(revokeCall(fetchSpy)?.[1]);
    expect(form.get('token')).toBe(token);
    expect(form.get('token_type_hint')).toBe('access_token');
    expect(form.get('client_id')).toBe('experience-catalyst-prod');
  });

  it('falls back to the proxy client_id when the token is not a readable JWT', async () => {
    const fetchSpy = stubRevokeFetch({
      config: () => new Response(JSON.stringify({ clientId: 'proxy-client' }), { status: 200 }),
    });
    seedAdobeAccount({
      accessToken: 'opaque-not-a-jwt',
      baseUrl: 'https://adobe-proxy.logout-opaque.test',
    });

    const { config } = await import('../../providers/adobe.js');
    await config.onOAuthLogout?.();

    expect(sentForm(revokeCall(fetchSpy)?.[1]).get('client_id')).toBe('proxy-client');
  });

  it('clears the stored token even when IMS refuses the revocation', async () => {
    // Logout must never strand a user with a live token in storage because the
    // revoke came back non-2xx — the local clear is unconditional.
    stubRevokeFetch({
      config: () => new Response(JSON.stringify({ clientId: 'proxy-client' }), { status: 200 }),
      revoke: () => new Response('nope', { status: 400 }),
    });
    seedAdobeAccount({ accessToken: imsToken(), baseUrl: 'https://adobe-proxy.logout-fail.test' });

    const { config } = await import('../../providers/adobe.js');
    await config.onOAuthLogout?.();

    expect((await readAdobeAccount())?.accessToken).toBe('');
  });

  it('still revokes and clears the token when the proxy config lookup fails', async () => {
    // The config call is best-effort: a dead proxy degrades to the build-time
    // defaults (prod IMS) rather than stopping the revoke — and the local clear
    // happens either way.
    const fetchSpy = stubFetch((url) => {
      if (url.includes('/v1/config')) throw new Error('proxy down');
      return new Response('', { status: 200 });
    });
    seedAdobeAccount({
      accessToken: imsToken('claim-client'),
      baseUrl: 'https://adobe-proxy.logout-deadcfg.test',
    });

    const { config } = await import('../../providers/adobe.js');
    await config.onOAuthLogout?.();

    expect(revokeCall(fetchSpy)?.[0]).toBe('https://ims-na1.adobelogin.com/ims/revoke');
    expect((await readAdobeAccount())?.accessToken).toBe('');
  });

  it('clears the token without calling IMS when nothing is stored', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    seedAdobeAccount({});

    const { config } = await import('../../providers/adobe.js');
    await config.onOAuthLogout?.();

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('adobe IMS profile lookup (where the display name comes from)', () => {
  const proxyEndpoint = 'https://adobe-proxy.profile.test';
  let originalFetch: typeof globalThis.fetch;
  let originalWindow: unknown;
  let originalDocument: unknown;
  let requested: string[];

  /** Answers for the two IMS profile endpoints, keyed by path. */
  type ProfileAnswers = Record<'/ims/profile/v1' | '/ims/userinfo/v2', unknown>;

  function installFetch(answers: ProfileAnswers): void {
    globalThis.fetch = vi.fn(async (url: unknown) => {
      const value = String(url);
      requested.push(value);
      if (value === `${proxyEndpoint}/v1/config`) {
        return new Response(JSON.stringify({ clientId: 'adobe-client', scopes: 'openid' }), {
          status: 200,
        });
      }
      for (const [path, body] of Object.entries(answers)) {
        if (!value.endsWith(path)) continue;
        return body === undefined
          ? new Response('', { status: 404 })
          : new Response(JSON.stringify(body), { status: 200 });
      }
      if (value === `${proxyEndpoint}/v1/models`) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      return new Response('', { status: 503 });
    }) as typeof globalThis.fetch;
  }

  async function loginAndReadAccount(): Promise<
    { userName?: string; accessToken?: string } | undefined
  > {
    storage.set(
      'slicc_accounts',
      JSON.stringify([{ providerId: 'adobe', apiKey: '', baseUrl: proxyEndpoint }])
    );
    const launcher = vi.fn(async (authorizeUrl: string) => {
      const authorize = new URL(authorizeUrl);
      const state = JSON.parse(atob(authorize.searchParams.get('state')!)) as { nonce: string };
      const redirectUri = authorize.searchParams.get('redirect_uri')!;
      return `${redirectUri}?nonce=${state.nonce}#access_token=${imsToken()}&expires_in=86400`;
    });
    const { config } = await import('../../providers/adobe.js');
    await config.onOAuthLogin?.(launcher, () => {});
    const { getAccounts } = await import('../../src/ui/provider-settings.js');
    return getAccounts().find((candidate) => candidate.providerId === 'adobe');
  }

  beforeEach(() => {
    storage.clear();
    vi.clearAllMocks();
    requested = [];
    originalFetch = globalThis.fetch;
    originalWindow = (globalThis as { window?: unknown }).window;
    originalDocument = (globalThis as { document?: unknown }).document;
    (globalThis as { window?: unknown }).window = {
      location: { origin: 'http://localhost:5710', href: 'http://localhost:5710/' },
    };
    (globalThis as { document?: unknown }).document = {};
    oauthServiceMocks.getOAuthPageOrigin.mockResolvedValue({
      origin: 'http://localhost:5710',
      href: 'http://localhost:5710/',
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = originalWindow;
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else (globalThis as { document?: unknown }).document = originalDocument;
  });

  it('takes the name from /ims/profile/v1 without asking the OIDC endpoint', async () => {
    installFetch({
      '/ims/profile/v1': { displayName: 'Lars Trieloff', email: 'lars@example.com' },
      '/ims/userinfo/v2': { displayName: 'should not be reached' },
    });

    const account = await loginAndReadAccount();

    expect(account?.userName).toBe('Lars Trieloff');
    expect(requested.some((url) => url.endsWith('/ims/userinfo/v2'))).toBe(false);
  });

  it('names the user even when the OIDC endpoint answers with only a subject', async () => {
    // The #2929 shape, verified against live IMS: `/ims/userinfo/v2` returns
    // `{"sub":"..."}` and nothing else unless the token carries the `profile`
    // / `email` scopes, which the proxy's scope set does not. Asking it alone
    // left every Adobe account with no display name at all.
    installFetch({
      '/ims/profile/v1': { displayName: 'Lars Trieloff' },
      '/ims/userinfo/v2': { sub: '4C5F22E269164EE60A495EE4@AdobeID' },
    });

    const account = await loginAndReadAccount();

    expect(account?.userName).toBe('Lars Trieloff');
  });

  it('falls back to the OIDC endpoint when the profile endpoint names nobody', async () => {
    // Kept as a fallback rather than replaced outright: a client whose scopes
    // make the OIDC endpoint the richer of the two must not regress.
    installFetch({
      '/ims/profile/v1': { sub: 'opaque-id-only' },
      '/ims/userinfo/v2': { displayName: 'Adobe User' },
    });

    const account = await loginAndReadAccount();

    expect(account?.userName).toBe('Adobe User');
    expect(requested.some((url) => url.endsWith('/ims/profile/v1'))).toBe(true);
  });

  it('still completes the login when no endpoint names the user', async () => {
    installFetch({ '/ims/profile/v1': undefined, '/ims/userinfo/v2': undefined });

    const account = await loginAndReadAccount();

    // A missing display name is cosmetic — it must never cost the token.
    expect(account?.userName).toBeUndefined();
    expect(account?.accessToken).toBe(imsToken());
  });
});
