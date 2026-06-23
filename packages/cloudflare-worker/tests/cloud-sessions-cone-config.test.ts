import { describe, expect, it } from 'vitest';
import { buildStartConeArgs, coneConfigToBundle } from '../src/cloud/cone-config-bridge.js';

/** Fake Adobe IMS JWT (base64url, atob-decodable — no node:Buffer in workers). */
function fakeImsJwt(createdAt: number, expiresIn: number): string {
  const b64url = (o: object) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return [
    b64url({ alg: 'RS256', typ: 'JWT' }),
    b64url({ created_at: String(createdAt), expires_in: String(expiresIn) }),
    'sig',
  ].join('.');
}

describe('coneConfigToBundle (worker-side default + validation)', () => {
  it('uses the supplied bundle when present', () => {
    const bundle = coneConfigToBundle(
      {
        model: 'anthropic:claude-opus-4-6',
        accounts: [{ providerId: 'anthropic', kind: 'apikey', apiKey: 'k' }],
        secrets: [],
      },
      'bearer-x'
    );
    expect(bundle.model).toBe('anthropic:claude-opus-4-6');
  });
  it('synthesizes the Adobe default when no coneConfig is supplied (opaque bearer ⇒ no expiry)', () => {
    const bundle = coneConfigToBundle(undefined, 'bearer-x');
    expect(bundle.model).toBe('adobe:claude-opus-4-6');
    expect(bundle.accounts).toEqual([
      { providerId: 'adobe', kind: 'oauth', accessToken: 'bearer-x' },
    ]);
  });
  it('stamps tokenExpiresAt on the synthesized Adobe account from a JWT bearer', () => {
    // Parity with node-server's legacy branch: a window-less kernel-worker cone
    // must not treat a still-valid IMS token as expired on its first turn.
    const created = 1_780_000_000_000;
    const ttl = 86_400_000;
    const bundle = coneConfigToBundle(undefined, fakeImsJwt(created, ttl));
    expect(bundle.accounts[0]).toMatchObject({
      providerId: 'adobe',
      kind: 'oauth',
      tokenExpiresAt: created + ttl,
    });
  });
  it('rejects a bundle whose model provider has no account (narrow F6)', () => {
    expect(() =>
      coneConfigToBundle(
        {
          model: 'openai:gpt-x',
          accounts: [{ providerId: 'anthropic', kind: 'apikey', apiKey: 'k' }],
          secrets: [],
        },
        'bearer-x'
      )
    ).toThrow(/provider 'openai' has no account/);
  });
});

describe('buildStartConeArgs', () => {
  it('produces envContents (secrets.env) + coneConfigJson ({model,accounts})', () => {
    const args = buildStartConeArgs(
      {
        model: 'm',
        accounts: [{ providerId: 'adobe', kind: 'oauth', accessToken: 't' }],
        secrets: [{ name: 'S', value: 'v', domains: ['x.com'] }],
      },
      'bearer'
    );
    expect(args.envContents).toContain('S=v');
    expect(JSON.parse(args.coneConfigJson).accounts[0].providerId).toBe('adobe');
  });
});
