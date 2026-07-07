import { describe, expect, it } from 'vitest';
import {
  bundleIndex,
  bundleToFiles,
  type ConeConfig,
  decodeBundleEnv,
  encodeBundleEnv,
  imsTokenExpiry,
  MAX_CONE_CONFIG_BYTES,
  mergeConeConfig,
  serializeSecretsEnv,
  validateConeConfig,
  validateConeConfigDelta,
} from '../../src/cone-config/index.js';

/**
 * Build a fake Adobe IMS access token (JWT) with the given timing claims,
 * using the portable base64url encoding that `imsTokenExpiry` decodes via
 * `atob` (no node:Buffer — this helper runs in the CF Worker too).
 */
function fakeImsJwt(createdAt: number, expiresIn: number): string {
  const b64url = (o: object) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return [
    b64url({ alg: 'RS256', typ: 'JWT' }),
    b64url({ created_at: String(createdAt), expires_in: String(expiresIn), type: 'access_token' }),
    'sig',
  ].join('.');
}

const base: ConeConfig = {
  model: 'anthropic:claude-opus-4-6',
  accounts: [
    { providerId: 'adobe', kind: 'oauth', accessToken: 'a', tokenExpiresAt: 0 },
    { providerId: 'anthropic', kind: 'apikey', apiKey: 'k' },
  ],
  secrets: [{ name: 'GITHUB_TOKEN', value: 'gt', domains: ['api.github.com', 'github.com'] }],
};

describe('validateConeConfig', () => {
  it('accepts a well-formed bundle', () => {
    expect(validateConeConfig(base)).toEqual(base);
  });
  it('rejects an oauth account missing accessToken', () => {
    expect(() =>
      validateConeConfig({ ...base, accounts: [{ providerId: 'x', kind: 'oauth' }] })
    ).toThrow(/accessToken/);
  });
  it('rejects an apikey account missing apiKey', () => {
    expect(() =>
      validateConeConfig({ ...base, accounts: [{ providerId: 'x', kind: 'apikey' }] })
    ).toThrow(/apiKey/);
  });
  it('rejects a secret whose domains is not string[]', () => {
    expect(() =>
      validateConeConfig({ ...base, secrets: [{ name: 'X', value: 'v', domains: 'a,b' }] })
    ).toThrow(/domains/);
  });
  it('rejects an account with a missing/invalid kind', () => {
    expect(() => validateConeConfig({ ...base, accounts: [{ providerId: 'x' }] })).toThrow(
      /kind required/
    );
  });
  it('rejects a secret name that is not an env-var identifier', () => {
    expect(() =>
      validateConeConfig({ ...base, secrets: [{ name: 'FOO=BAR', value: 'v', domains: [] }] })
    ).toThrow(/identifier/);
  });
  it('rejects a secret value or domain with a newline (secrets.env is line-based)', () => {
    expect(() =>
      validateConeConfig({ ...base, secrets: [{ name: 'X', value: 'a\nb', domains: [] }] })
    ).toThrow(/single-line/);
    expect(() =>
      validateConeConfig({ ...base, secrets: [{ name: 'X', value: 'v', domains: ['a,b'] }] })
    ).toThrow(/comma-free/);
  });
  it('accepts a config with a valid effortLevel', () => {
    expect(validateConeConfig({ ...base, effortLevel: 'high' })).toEqual({
      ...base,
      effortLevel: 'high',
    });
  });
  it('accepts a config without effortLevel (it is optional)', () => {
    expect(validateConeConfig(base)).toEqual(base);
    expect(validateConeConfig(base).effortLevel).toBeUndefined();
  });
  it('rejects an invalid effortLevel string', () => {
    expect(() => validateConeConfig({ ...base, effortLevel: 'ultra' })).toThrow(/effortLevel/);
  });
});

describe('validateConeConfigDelta', () => {
  it('accepts a well-formed delta', () => {
    const d = {
      model: 'openai:x',
      upsert: { accounts: [{ providerId: 'openai', kind: 'apikey', apiKey: 'k' }], secrets: [] },
      delete: { providerIds: ['adobe'], secretNames: ['OLD'] },
    };
    expect(validateConeConfigDelta(d)).toEqual(d);
  });
  it('rejects a non-array upsert.accounts', () => {
    expect(() => validateConeConfigDelta({ upsert: { accounts: 'nope' } })).toThrow(
      /upsert.accounts must be an array/
    );
  });
  it('rejects a nested secret that would inject a newline', () => {
    expect(() =>
      validateConeConfigDelta({ upsert: { secrets: [{ name: 'X', value: 'a\nb', domains: [] }] } })
    ).toThrow(/single-line/);
  });
  it('rejects a non-string delete.secretNames entry', () => {
    expect(() => validateConeConfigDelta({ delete: { secretNames: [1] } })).toThrow(
      /secretNames must be string\[\]/
    );
  });
  it('accepts an empty delta', () => {
    expect(validateConeConfigDelta({})).toEqual({});
  });
  it('accepts a delta with a valid effortLevel', () => {
    expect(validateConeConfigDelta({ effortLevel: 'low' })).toEqual({ effortLevel: 'low' });
  });
  it('accepts a delta with effortLevel: null (to clear it)', () => {
    expect(validateConeConfigDelta({ effortLevel: null })).toEqual({ effortLevel: null });
  });
  it('rejects a delta with an invalid effortLevel', () => {
    expect(() => validateConeConfigDelta({ effortLevel: 'turbo' })).toThrow(/effortLevel/);
  });
});

describe('mergeConeConfig', () => {
  it('upserts accounts by providerId and secrets by name, and deletes', () => {
    const merged = mergeConeConfig(base, {
      upsert: {
        accounts: [{ providerId: 'anthropic', kind: 'apikey', apiKey: 'k2' }],
        secrets: [{ name: 'NEW', value: 'n', domains: ['x.com'] }],
      },
      delete: { providerIds: ['adobe'], secretNames: ['GITHUB_TOKEN'] },
    });
    expect(merged.accounts).toEqual([{ providerId: 'anthropic', kind: 'apikey', apiKey: 'k2' }]);
    expect(merged.secrets).toEqual([{ name: 'NEW', value: 'n', domains: ['x.com'] }]);
    expect(merged.model).toBe('anthropic:claude-opus-4-6');
  });
  it('replaces model only when the delta provides one', () => {
    expect(mergeConeConfig(base, { model: 'openai:gpt-x' }).model).toBe('openai:gpt-x');
    expect(mergeConeConfig(base, {}).model).toBe('anthropic:claude-opus-4-6');
  });
  it('handles upsert-only, delete-only, and empty deltas without mutating base', () => {
    const snapshot = JSON.parse(JSON.stringify(base));
    expect(
      mergeConeConfig(base, { upsert: { secrets: [{ name: 'A', value: 'v', domains: ['x'] }] } })
        .secrets
    ).toHaveLength(2);
    expect(mergeConeConfig(base, { delete: { providerIds: ['anthropic'] } }).accounts).toHaveLength(
      1
    );
    expect(mergeConeConfig(base, {}).accounts).toEqual(base.accounts);
    expect(base).toEqual(snapshot); // base not mutated
  });
  it('applies effortLevel from delta when present', () => {
    expect(mergeConeConfig(base, { effortLevel: 'medium' }).effortLevel).toBe('medium');
  });
  it('clears effortLevel when delta specifies null', () => {
    const withEffort: ConeConfig = { ...base, effortLevel: 'high' };
    expect(mergeConeConfig(withEffort, { effortLevel: null }).effortLevel).toBeUndefined();
  });
  it('preserves base effortLevel when delta does not mention it', () => {
    const withEffort: ConeConfig = { ...base, effortLevel: 'low' };
    expect(mergeConeConfig(withEffort, {}).effortLevel).toBe('low');
  });
});

describe('serializeSecretsEnv + bundleToFiles', () => {
  it('emits NAME and NAME_DOMAINS lines', () => {
    expect(serializeSecretsEnv(base.secrets)).toBe(
      'GITHUB_TOKEN=gt\nGITHUB_TOKEN_DOMAINS=api.github.com,github.com\n'
    );
  });
  it('emits empty string for no secrets', () => {
    expect(serializeSecretsEnv([])).toBe('');
  });
  it('splits a bundle into cone-config.json + secrets.env', () => {
    const { coneConfigJson, secretsEnv } = bundleToFiles(base);
    expect(JSON.parse(coneConfigJson)).toEqual({ model: base.model, accounts: base.accounts });
    expect(secretsEnv).toContain('GITHUB_TOKEN=gt');
  });
  it('includes effortLevel in the JSON when set', () => {
    const withEffort: ConeConfig = { ...base, effortLevel: 'xhigh' };
    const { coneConfigJson } = bundleToFiles(withEffort);
    expect(JSON.parse(coneConfigJson)).toEqual({
      model: base.model,
      effortLevel: 'xhigh',
      accounts: base.accounts,
    });
  });
  it('omits effortLevel from the JSON when not set', () => {
    const { coneConfigJson } = bundleToFiles(base);
    expect(JSON.parse(coneConfigJson)).not.toHaveProperty('effortLevel');
  });
});

describe('bundleIndex', () => {
  it('produces a names-only index with no values', () => {
    const idx = bundleIndex(base);
    expect(idx).toEqual({
      model: 'anthropic:claude-opus-4-6',
      accountProviderIds: ['adobe', 'anthropic'],
      accountMeta: [
        { providerId: 'adobe', kind: 'oauth', tokenExpiresAt: 0 },
        { providerId: 'anthropic', kind: 'apikey', tokenExpiresAt: undefined },
      ],
      secretNames: ['GITHUB_TOKEN'],
    });
    expect(JSON.stringify(idx)).not.toContain('gt'); // no secret values leak
  });
  it('includes effortLevel in the index when set', () => {
    const withEffort: ConeConfig = { ...base, effortLevel: 'minimal' };
    const idx = bundleIndex(withEffort);
    expect(idx.effortLevel).toBe('minimal');
  });
});

describe('base64 env round-trip', () => {
  it('round-trips UTF-8 JSON', () => {
    const json = JSON.stringify({ s: 'héllo — 🍦' });
    expect(decodeBundleEnv(encodeBundleEnv(json))).toBe(json);
  });
  it('exposes a positive size cap', () => {
    expect(MAX_CONE_CONFIG_BYTES).toBeGreaterThan(0);
  });
});

describe('imsTokenExpiry', () => {
  it('returns created_at + expires_in for a JWT IMS token', () => {
    expect(imsTokenExpiry(fakeImsJwt(1_780_000_000_000, 86_400_000))).toBe(
      1_780_000_000_000 + 86_400_000
    );
  });

  it('returns undefined for an opaque (non-JWT) token', () => {
    expect(imsTokenExpiry('opaque-token')).toBeUndefined();
  });

  it('returns undefined when the JWT payload lacks timing claims', () => {
    const b64url = (o: object) =>
      btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const token = [b64url({ alg: 'RS256' }), b64url({ sub: 'x' }), 'sig'].join('.');
    expect(imsTokenExpiry(token)).toBeUndefined();
  });

  it('returns undefined when timing claims are non-positive', () => {
    expect(imsTokenExpiry(fakeImsJwt(0, 86_400_000))).toBeUndefined();
    expect(imsTokenExpiry(fakeImsJwt(1_780_000_000_000, 0))).toBeUndefined();
  });

  it('returns undefined for a malformed base64 payload', () => {
    expect(imsTokenExpiry('a.!!!notbase64!!!.c')).toBeUndefined();
  });
});
