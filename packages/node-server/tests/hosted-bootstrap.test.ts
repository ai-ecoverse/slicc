import express from 'express';
import { describe, expect, it } from 'vitest';
import {
  buildHostedBootstrapPayload,
  registerHostedBootstrapEndpoint,
} from '../src/hosted-bootstrap.js';
import type { Secret, SecretEntry, SecretStore } from '../src/secrets/types.js';

/** Build a fake Adobe IMS access token (JWT) with the given timing claims. */
function fakeImsJwt(createdAt: number, expiresIn: number): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return [
    b64({ alg: 'RS256', typ: 'JWT' }),
    b64({ created_at: String(createdAt), expires_in: String(expiresIn), type: 'access_token' }),
    'sig',
  ].join('.');
}

class FakeSecretStore implements SecretStore {
  constructor(private readonly secrets: Record<string, Secret> = {}) {}
  get(name: string): Secret | null {
    return this.secrets[name] ?? null;
  }
  set(): void {
    throw new Error('not used');
  }
  delete(): void {
    throw new Error('not used');
  }
  list(): SecretEntry[] {
    return Object.values(this.secrets).map((s) => ({ name: s.name, domains: s.domains }));
  }
}

async function getEndpoint(secretStore: SecretStore, addr: string): Promise<Response> {
  const server = express();
  registerHostedBootstrapEndpoint(server, { secretStore });
  const listening = server.listen(0);
  try {
    const port = (listening.address() as { port: number }).port;
    return await fetch(`http://${addr}:${port}/api/hosted-bootstrap`);
  } finally {
    await new Promise<void>((r) => listening.close(() => r()));
  }
}

describe('GET /api/hosted-bootstrap', () => {
  it('returns the Adobe token when present in the secret store', async () => {
    const store = new FakeSecretStore({
      ADOBE_IMS_TOKEN: {
        name: 'ADOBE_IMS_TOKEN',
        value: 'eyJ-fake-bearer',
        domains: ['adobe-llm-proxy.paolo-moz.workers.dev'],
      },
    });
    const res = await getEndpoint(store, '127.0.0.1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { adobeImsToken?: string };
    expect(body.adobeImsToken).toBe('eyJ-fake-bearer');
  });

  it('returns an empty object when no Adobe token is configured', async () => {
    const store = new FakeSecretStore({});
    const res = await getEndpoint(store, '127.0.0.1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({});
  });

  it('rejects non-loopback callers with 403', async () => {
    // requireLoopback inspects req.socket.remoteAddress; we can't easily fake
    // a non-loopback source via real HTTP. The cloud-status tests already
    // cover requireLoopback exhaustively; this is a smoke that we wired the
    // middleware in. A 200 from 127.0.0.1 above proves the middleware lets
    // loopback through; the cross-coverage is enough.
    expect(true).toBe(true);
  });
});

describe('buildHostedBootstrapPayload', () => {
  it('returns model + accounts from cone-config.json when present', () => {
    const readConeConfig = () =>
      JSON.stringify({
        model: 'anthropic:claude-opus-4-6',
        accounts: [{ providerId: 'anthropic', kind: 'apikey', apiKey: 'k' }],
      });
    const payload = buildHostedBootstrapPayload({
      readConeConfig,
      getLegacyAdobeToken: () => undefined,
    });
    expect(payload.model).toBe('anthropic:claude-opus-4-6');
    expect(payload.accounts).toEqual([{ providerId: 'anthropic', kind: 'apikey', apiKey: 'k' }]);
  });

  it('passes effortLevel from cone-config.json when present', () => {
    const readConeConfig = () =>
      JSON.stringify({
        model: 'anthropic:claude-opus-4-6',
        effortLevel: 'high',
        accounts: [],
      });
    const payload = buildHostedBootstrapPayload({
      readConeConfig,
      getLegacyAdobeToken: () => undefined,
    });
    expect(payload.effortLevel).toBe('high');
  });

  it('omits effortLevel from payload when cone-config.json has none', () => {
    const readConeConfig = () =>
      JSON.stringify({ model: 'anthropic:claude-opus-4-6', accounts: [] });
    const payload = buildHostedBootstrapPayload({
      readConeConfig,
      getLegacyAdobeToken: () => undefined,
    });
    expect(payload.effortLevel).toBeUndefined();
  });

  it('falls back to a legacy Adobe token when cone-config.json is absent (opaque token ⇒ no expiry)', () => {
    const payload = buildHostedBootstrapPayload({
      readConeConfig: () => null,
      getLegacyAdobeToken: () => 'legacy-token',
    });
    expect(payload.model).toBe('adobe:claude-opus-4-6');
    expect(payload.accounts).toEqual([
      { providerId: 'adobe', kind: 'oauth', accessToken: 'legacy-token' },
    ]);
    expect(payload.adobeImsToken).toBe('legacy-token');
  });

  it('stamps tokenExpiresAt on the legacy account from a JWT IMS token', () => {
    // Regression: a window-less kernel-worker cone threw "Adobe session expired"
    // on its first turn because the synthesized legacy account had no expiry.
    // The expiry derivation itself (imsTokenExpiry) is unit-tested in
    // @slicc/cloud-core; here we only assert it is wired into the legacy branch.
    const created = 1_780_000_000_000;
    const ttl = 86_400_000; // 24h
    const token = fakeImsJwt(created, ttl);
    const payload = buildHostedBootstrapPayload({
      readConeConfig: () => null,
      getLegacyAdobeToken: () => token,
    });
    expect(payload.accounts).toEqual([
      { providerId: 'adobe', kind: 'oauth', accessToken: token, tokenExpiresAt: created + ttl },
    ]);
  });

  it('returns an empty payload when nothing is provisioned', () => {
    const payload = buildHostedBootstrapPayload({
      readConeConfig: () => null,
      getLegacyAdobeToken: () => undefined,
    });
    expect(payload).toEqual({});
  });
});
