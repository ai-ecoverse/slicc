/**
 * APNs sender (#2062): provider-JWT minting + caching, request shape per
 * category, and response classification (dead tokens, stale JWT retry,
 * transport failure). Uses a freshly generated P-256 key — no Apple secrets.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type ApnsPushRequest,
  apnsConfigFromEnv,
  apnsHost,
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
const reject = (status: number, reason: string) =>
  new Response(JSON.stringify({ reason }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

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

describe('WebCryptoApnsSender', () => {
  it('mints an ES256 provider JWT and caches it for 50 minutes', async () => {
    let now = 1_750_000_000_000;
    const sender = new WebCryptoApnsSender(CONFIG(), { now: () => now });
    const first = await sender.providerToken();
    const [header, claims, signature] = first.split('.');
    const decode = (s: string) => JSON.parse(atob(s.replace(/-/g, '+').replace(/_/g, '/')));
    expect(decode(header)).toEqual({ alg: 'ES256', kid: 'KEY5678' });
    expect(decode(claims)).toEqual({ iss: 'TEAM1234', iat: 1_750_000_000 });
    // Raw r||s signature, 64 bytes → 86 base64url chars.
    expect(signature).toHaveLength(86);

    now += 10 * 60 * 1000;
    expect(await sender.providerToken()).toBe(first);
    now += 41 * 60 * 1000;
    expect(await sender.providerToken()).not.toBe(first);
  });

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

  it('flags dead tokens from 410 and BadDeviceToken, keeps others', async () => {
    const gone = new WebCryptoApnsSender(CONFIG(), {
      fetchImpl: fakeFetch(() => reject(410, 'Unregistered')).impl,
    });
    expect(await gone.send(REQ)).toMatchObject({
      status: 410,
      reason: 'Unregistered',
      dropToken: true,
    });

    const bad = new WebCryptoApnsSender(CONFIG(), {
      fetchImpl: fakeFetch(() => reject(400, 'BadDeviceToken')).impl,
    });
    expect(await bad.send(REQ)).toMatchObject({ status: 400, dropToken: true });

    const busy = new WebCryptoApnsSender(CONFIG(), {
      fetchImpl: fakeFetch(() => reject(503, 'ServiceUnavailable')).impl,
    });
    expect(await busy.send(REQ)).toMatchObject({ status: 503, dropToken: false });

    const opaque = new WebCryptoApnsSender(CONFIG(), {
      fetchImpl: fakeFetch(() => new Response('nope', { status: 500 })).impl,
    });
    expect(await opaque.send(REQ)).toEqual({ token: REQ.token, status: 500, dropToken: false });
  });

  it('re-mints the JWT once on ExpiredProviderToken and retries', async () => {
    let attempt = 0;
    const { impl, calls } = fakeFetch(() =>
      ++attempt === 1 ? reject(403, 'ExpiredProviderToken') : ok()
    );
    const sender = new WebCryptoApnsSender(CONFIG(), { fetchImpl: impl });
    expect(await sender.send(REQ)).toMatchObject({ status: 200 });
    expect(calls).toHaveLength(2);
    const auth = (i: number) => (calls[i].init.headers as Record<string, string>).authorization;
    expect(auth(0)).not.toBe(auth(1));
  });

  it('reports a transport failure without dropping the token', async () => {
    const impl = vi.fn(async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    const sender = new WebCryptoApnsSender(CONFIG(), { fetchImpl: impl });
    expect(await sender.send(REQ)).toEqual({
      token: REQ.token,
      status: 0,
      reason: 'ECONNRESET',
      dropToken: false,
    });
  });

  it('accepts a PEM whose newlines were escaped by the secret store', async () => {
    const escaped = pem.replace(/\n/g, '\\n');
    const sender = new WebCryptoApnsSender({ ...CONFIG(), privateKeyPem: escaped });
    await expect(sender.providerToken()).resolves.toMatch(/^ey/);
  });
});
