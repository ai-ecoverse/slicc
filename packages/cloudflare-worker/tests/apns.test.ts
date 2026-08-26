/**
 * APNs sender (#2062, #2432): provider-JWT minting under Apple's per-key
 * throttle, request shape per category, and response classification (dead
 * tokens, stale JWT, transient retry, transport failure). Uses a freshly
 * generated P-256 key — no Apple secrets.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type ApnsProviderToken,
  type ApnsProviderTokenSource,
  type ApnsPushRequest,
  apnsConfigFromEnv,
  apnsHost,
  JWT_MIN_MINT_INTERVAL_MS,
  LocalProviderTokenMinter,
  type ProviderTokenStore,
  WebCryptoApnsSender,
} from '../src/apns.js';

let pem = '';

function toPem(pkcs8: ArrayBuffer): string {
  const b64 = btoa(String.fromCharCode(...new Uint8Array(pkcs8)));
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----\n`;
}

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  pem = toPem((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer);
});

const CONFIG = () => ({
  teamId: 'TEAM1234',
  keyId: 'KEY5678',
  privateKeyPem: pem,
  topic: 'com.sliccy.follower',
});

const REQ: ApnsPushRequest = {
  token: 'a'.repeat(64),
  environment: 'sandbox',
  category: 'sudo_request',
  label: 'Researcher',
  trayId: 'tray-1',
  requestId: 'sudo-9',
};

function fakeFetch(responder: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init: init ?? {} });
    return responder(u, init ?? {});
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const ok = () => new Response(null, { status: 200 });
const reject = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** Never sleep for real in tests; assert the retry happened instead. */
const noSleep = () => Promise.resolve();

/** A token source that hands out fixed values, recording what was asked for. */
function stubSource(
  tokens: string[]
): ApnsProviderTokenSource & { asked: Array<string | undefined> } {
  const asked: Array<string | undefined> = [];
  let i = 0;
  return {
    asked,
    async getToken(staleToken?: string): Promise<ApnsProviderToken> {
      asked.push(staleToken);
      const value = tokens[Math.min(i, tokens.length - 1)];
      i += 1;
      return { value, mintedAt: 0, identity: 'TEAM1234.KEY5678' };
    },
  };
}

describe('apnsConfigFromEnv', () => {
  it('requires all four secrets', () => {
    expect(apnsConfigFromEnv({})).toBeNull();
    expect(
      apnsConfigFromEnv({ APNS_TEAM_ID: 't', APNS_KEY_ID: 'k', APNS_PRIVATE_KEY: 'p' })
    ).toBeNull();
    expect(
      apnsConfigFromEnv({
        APNS_TEAM_ID: ' t ',
        APNS_KEY_ID: 'k',
        APNS_PRIVATE_KEY: 'p',
        APNS_TOPIC: 'x',
      })
    ).toEqual({ teamId: 't', keyId: 'k', privateKeyPem: 'p', topic: 'x' });
  });

  it('picks the gateway per environment', () => {
    expect(apnsHost('sandbox')).toContain('api.sandbox.push.apple.com');
    expect(apnsHost('production')).toBe('https://api.push.apple.com');
  });
});

describe('LocalProviderTokenMinter', () => {
  it('mints an ES256 provider JWT and caches it for 50 minutes', async () => {
    let now = 1_750_000_000_000;
    const minter = new LocalProviderTokenMinter(CONFIG(), { now: () => now });
    const first = await minter.getToken();
    const [header, claims, signature] = first.value.split('.');
    const decode = (s: string) => JSON.parse(atob(s.replace(/-/g, '+').replace(/_/g, '/')));
    expect(decode(header)).toEqual({ alg: 'ES256', kid: 'KEY5678' });
    expect(decode(claims)).toEqual({ iss: 'TEAM1234', iat: 1_750_000_000 });
    // Raw r||s signature, 64 bytes → 86 base64url chars.
    expect(signature).toHaveLength(86);
    expect(first.mintedAt).toBe(now);

    now += 10 * 60 * 1000;
    expect((await minter.getToken()).value).toBe(first.value);
    now += 41 * 60 * 1000;
    expect((await minter.getToken()).value).not.toBe(first.value);
  });

  it('accepts a PEM whose newlines were escaped by the secret store', async () => {
    const escaped = pem.replace(/\n/g, '\\n');
    const minter = new LocalProviderTokenMinter({ ...CONFIG(), privateKeyPem: escaped });
    await expect(minter.getToken()).resolves.toMatchObject({ value: expect.stringMatching(/^ey/) });
  });

  it('collapses concurrent callers onto a single mint', async () => {
    // The whole point of the singleton: a herd of tray DOs waking at once must
    // not each sign their own JWT. Same instance, simultaneous callers.
    const signSpy = vi.spyOn(crypto.subtle, 'sign');
    const before = signSpy.mock.calls.length;
    const minter = new LocalProviderTokenMinter(CONFIG(), { now: () => 1_750_000_000_000 });
    const tokens = await Promise.all(Array.from({ length: 8 }, () => minter.getToken()));
    expect(signSpy.mock.calls.length - before).toBe(1);
    expect(new Set(tokens.map((t) => t.value)).size).toBe(1);
    signSpy.mockRestore();
  });

  it('refuses to rotate inside Apple’s 20-minute floor, even when told the token is stale', async () => {
    // Minting faster than this is what earns 429 TooManyProviderTokenUpdates,
    // and that penalty outlives the single push we would be rescuing.
    let now = 1_750_000_000_000;
    const minter = new LocalProviderTokenMinter(CONFIG(), { now: () => now });
    const first = await minter.getToken();

    now += 5 * 60 * 1000;
    expect((await minter.getToken(first.value)).value).toBe(first.value);

    now += JWT_MIN_MINT_INTERVAL_MS;
    expect((await minter.getToken(first.value)).value).not.toBe(first.value);
  });

  it('hands a caller the newer token when someone else already rotated', async () => {
    let now = 1_750_000_000_000;
    const minter = new LocalProviderTokenMinter(CONFIG(), { now: () => now });
    const first = await minter.getToken();
    now += JWT_MIN_MINT_INTERVAL_MS + 1;
    const second = await minter.getToken(first.value);
    expect(second.value).not.toBe(first.value);

    // A straggler still reporting the *original* token gets the rotated one
    // back without triggering another mint.
    const straggler = await minter.getToken(first.value);
    expect(straggler.value).toBe(second.value);
  });

  it('resumes from the store instead of minting after hibernation', async () => {
    // A Durable Object evicted between pushes reconstructs this class; without
    // the store it would sign a fresh JWT on every wake (issue #2432).
    const saved: ApnsProviderToken[] = [];
    const store: ProviderTokenStore = {
      load: async () => saved.at(-1) ?? null,
      save: async (token) => {
        saved.push(token);
      },
    };
    const now = () => 1_750_000_000_000;
    const first = await new LocalProviderTokenMinter(CONFIG(), { now, store }).getToken();
    expect(saved).toHaveLength(1);

    const reconstructed = new LocalProviderTokenMinter(CONFIG(), { now, store });
    expect((await reconstructed.getToken()).value).toBe(first.value);
    expect(saved).toHaveLength(1);
  });
});

describe('WebCryptoApnsSender', () => {
  it('posts the sudo payload with time-sensitive headers to the sandbox gateway', async () => {
    const { impl, calls } = fakeFetch(() => ok());
    const sender = new WebCryptoApnsSender(CONFIG(), {
      fetchImpl: impl,
      now: () => 1_750_000_000_000,
    });
    const result = await sender.send(REQ);
    expect(result).toEqual({ token: REQ.token, status: 200, dropToken: false });
    expect(calls[0].url).toBe(`https://api.sandbox.push.apple.com/3/device/${REQ.token}`);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['apns-topic']).toBe('com.sliccy.follower');
    expect(headers['apns-push-type']).toBe('alert');
    expect(headers['apns-priority']).toBe('10');
    expect(headers['apns-collapse-id']).toBe('sudo-9');
    expect(headers['apns-expiration']).toBe(String(1_750_000_000 + 300));
    expect(headers.authorization).toMatch(/^bearer ey/);
    const body = JSON.parse(String(calls[0].init.body)) as { aps: Record<string, unknown> };
    expect(body.aps['interruption-level']).toBe('time-sensitive');
    expect(body.aps.category).toBe('SLICC_SUDO_REQUEST');
  });

  it('collapses turn_end banners per tray on the production gateway', async () => {
    const { impl, calls } = fakeFetch(() => ok());
    const sender = new WebCryptoApnsSender(CONFIG(), { fetchImpl: impl });
    await sender.send({
      ...REQ,
      environment: 'production',
      category: 'turn_end',
      requestId: undefined,
    });
    expect(calls[0].url.startsWith('https://api.push.apple.com/')).toBe(true);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['apns-collapse-id']).toBe('turn-end:tray-1');
    expect(headers['apns-expiration']).toBeUndefined();
  });

  it('clears the request timeout so a finished push does not pin the DO awake', async () => {
    // The uncleared AbortSignal.timeout held the Durable Object's IO context
    // open for the full 8s budget after every *successful* push (#2432), which
    // is billed wall time. Assert the timer is cleared, not merely armed.
    vi.useFakeTimers();
    try {
      const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
      const sender = new WebCryptoApnsSender(CONFIG(), { fetchImpl: fakeFetch(() => ok()).impl });
      await sender.send(REQ);
      expect(clearSpy).toHaveBeenCalled();
      // Nothing left armed: advancing past the budget must not fire an abort.
      expect(vi.getTimerCount()).toBe(0);
      clearSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports the apns-unique-id so a failed push can be traced with Apple', async () => {
    const { impl } = fakeFetch(
      () =>
        new Response(JSON.stringify({ reason: 'BadCollapseId' }), {
          status: 400,
          headers: { 'content-type': 'application/json', 'apns-unique-id': 'ABC-123' },
        })
    );
    const sender = new WebCryptoApnsSender(CONFIG(), { fetchImpl: impl });
    expect(await sender.send(REQ)).toMatchObject({ uniqueId: 'ABC-123', dropToken: false });
  });

  it('flags dead tokens from 410 and BadDeviceToken, keeps others', async () => {
    const gone = new WebCryptoApnsSender(CONFIG(), {
      fetchImpl: fakeFetch(() => reject(410, { reason: 'Unregistered', timestamp: 1_700_000 }))
        .impl,
    });
    expect(await gone.send(REQ)).toMatchObject({
      status: 410,
      reason: 'Unregistered',
      dropToken: true,
      invalidatedAtMs: 1_700_000,
    });

    const bad = new WebCryptoApnsSender(CONFIG(), {
      fetchImpl: fakeFetch(() => reject(400, { reason: 'BadDeviceToken' })).impl,
    });
    const badResult = await bad.send(REQ);
    expect(badResult).toMatchObject({ status: 400, dropToken: true });
    // No timestamp on a 400 — the caller must treat it as unconditionally final.
    expect(badResult.invalidatedAtMs).toBeUndefined();

    const opaque = new WebCryptoApnsSender(CONFIG(), {
      fetchImpl: fakeFetch(() => new Response('nope', { status: 400 })).impl,
    });
    expect(await opaque.send(REQ)).toEqual({ token: REQ.token, status: 400, dropToken: false });
  });

  it('retries a stale JWT only against a genuinely different token', async () => {
    let attempt = 0;
    const { impl, calls } = fakeFetch(() =>
      ++attempt === 1 ? reject(403, { reason: 'ExpiredProviderToken' }) : ok()
    );
    const source = stubSource(['jwt-old', 'jwt-new']);
    const sender = new WebCryptoApnsSender(CONFIG(), { fetchImpl: impl, tokenSource: source });
    expect(await sender.send(REQ)).toMatchObject({ status: 200 });
    expect(calls).toHaveLength(2);
    expect(source.asked).toEqual([undefined, 'jwt-old']);
    const auth = (i: number) => (calls[i].init.headers as Record<string, string>).authorization;
    expect(auth(0)).toBe('bearer jwt-old');
    expect(auth(1)).toBe('bearer jwt-new');
  });

  it('gives up rather than re-post the same JWT the gateway just refused', async () => {
    // The source declining to rotate (Apple's 20-minute floor) is an answer,
    // not a hint to try again — a second post would burn a request and, for
    // TooManyProviderTokenUpdates, deepen the throttle we are already in.
    const { impl, calls } = fakeFetch(() => reject(429, { reason: 'TooManyProviderTokenUpdates' }));
    const source = stubSource(['jwt-pinned']);
    const sender = new WebCryptoApnsSender(CONFIG(), { fetchImpl: impl, tokenSource: source });
    expect(await sender.send(REQ)).toMatchObject({
      status: 429,
      reason: 'TooManyProviderTokenUpdates',
      dropToken: false,
    });
    expect(calls).toHaveLength(1);
    // It still asked — that is how a caller picks up someone else's rotation.
    expect(source.asked).toEqual([undefined, 'jwt-pinned']);
  });

  it('retries a 503 once and succeeds', async () => {
    let attempt = 0;
    const { impl, calls } = fakeFetch(() =>
      ++attempt === 1 ? reject(503, { reason: 'ServiceUnavailable' }) : ok()
    );
    const sender = new WebCryptoApnsSender(CONFIG(), { fetchImpl: impl, sleep: noSleep });
    expect(await sender.send(REQ)).toMatchObject({ status: 200 });
    expect(calls).toHaveLength(2);
  });

  it('retries a transport failure but never a timeout', async () => {
    const flaky = vi.fn(async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    const sender = new WebCryptoApnsSender(CONFIG(), { fetchImpl: flaky, sleep: noSleep });
    expect(await sender.send(REQ)).toEqual({
      token: REQ.token,
      status: 0,
      reason: 'ECONNRESET',
      dropToken: false,
    });
    expect(flaky).toHaveBeenCalledTimes(2);

    // A timeout already spent the full 8s budget; retrying would double the
    // wall time the Durable Object is held open for nothing.
    const timeout = vi.fn(async (_url: unknown, init?: RequestInit) => {
      (init?.signal as AbortSignal | undefined)?.throwIfAborted?.();
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }) as unknown as typeof fetch;
    const timingOut = new WebCryptoApnsSender(CONFIG(), { fetchImpl: timeout, sleep: noSleep });
    expect(await timingOut.send(REQ)).toMatchObject({
      status: 0,
      reason: 'APNs request timed out',
    });
    expect(timeout).toHaveBeenCalledTimes(1);
  });
});
