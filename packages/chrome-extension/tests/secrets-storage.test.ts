/**
 * Tests for the Mount Secrets options page storage logic.
 *
 * The pure functions in `src/secrets-storage.ts` accept any object that
 * implements the `StorageArea` shape, which lets us test against an
 * in-memory mock without a browser context. The DOM-bound entrypoint
 * (`src/secrets-entry.ts`) is integration-only and not unit-tested.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  PROFILE_RE,
  deleteSecret,
  deriveS3Domains,
  listSecrets,
  saveCustomSecret,
  saveS3Profile,
  setSecret,
  validateCustomSecretInput,
  validateS3ProfileInput,
  type StorageArea,
} from '../src/secrets-storage.js';

class MemStorage implements StorageArea {
  private map = new Map<string, unknown>();

  async get(keys?: null | string | string[]): Promise<Record<string, unknown>> {
    if (keys == null) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of this.map.entries()) out[k] = v;
      return out;
    }
    const list = typeof keys === 'string' ? [keys] : keys;
    const out: Record<string, unknown> = {};
    for (const k of list) {
      if (this.map.has(k)) out[k] = this.map.get(k);
    }
    return out;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    for (const [k, v] of Object.entries(items)) this.map.set(k, v);
  }

  async remove(keys: string | string[]): Promise<void> {
    const list = typeof keys === 'string' ? [keys] : keys;
    for (const k of list) this.map.delete(k);
  }

  /** Test-only escape hatch for setup that pre-seeds odd shapes. */
  raw(): Map<string, unknown> {
    return this.map;
  }
}

// ----------------- listSecrets -----------------

describe('listSecrets', () => {
  let storage: MemStorage;
  beforeEach(() => {
    storage = new MemStorage();
  });

  it('returns empty list when storage is empty', async () => {
    expect(await listSecrets(storage)).toEqual([]);
  });

  it('returns secrets that have a matching _DOMAINS entry', async () => {
    storage.raw().set('GITHUB_TOKEN', 'ghp_abc');
    storage.raw().set('GITHUB_TOKEN_DOMAINS', 'api.github.com,*.github.com');
    expect(await listSecrets(storage)).toEqual([
      { name: 'GITHUB_TOKEN', domains: ['api.github.com', '*.github.com'] },
    ]);
  });

  it('skips secrets without a _DOMAINS entry', async () => {
    storage.raw().set('UNSCOPED', 'value');
    // No UNSCOPED_DOMAINS — should be filtered out (matches env-secret-store).
    expect(await listSecrets(storage)).toEqual([]);
  });

  it('skips _DOMAINS entries without a matching value', async () => {
    storage.raw().set('GHOST_DOMAINS', '*.example.com');
    // GHOST is missing — neither the value nor the orphan _DOMAINS surfaces.
    expect(await listSecrets(storage)).toEqual([]);
  });

  it('skips secrets whose _DOMAINS resolves to an empty list', async () => {
    storage.raw().set('EMPTY', 'value');
    storage.raw().set('EMPTY_DOMAINS', '   ,   ,'); // all whitespace
    expect(await listSecrets(storage)).toEqual([]);
  });

  it('skips non-string values', async () => {
    storage.raw().set('NUMERIC', 42);
    storage.raw().set('NUMERIC_DOMAINS', 'example.com');
    expect(await listSecrets(storage)).toEqual([]);
  });

  it('sorts entries alphabetically by name', async () => {
    storage.raw().set('zoo', 'v1');
    storage.raw().set('zoo_DOMAINS', 'example.com');
    storage.raw().set('apple', 'v2');
    storage.raw().set('apple_DOMAINS', 'example.com');
    storage.raw().set('mango', 'v3');
    storage.raw().set('mango_DOMAINS', 'example.com');
    const names = (await listSecrets(storage)).map((e) => e.name);
    expect(names).toEqual(['apple', 'mango', 'zoo']);
  });

  it('round-trips a complex S3 profile (all five paired keys)', async () => {
    await saveS3Profile(storage, {
      profile: 'r2',
      accessKey: 'AKIA1',
      secretKey: 'sak',
      region: 'auto',
      endpoint: 'https://account.r2.cloudflarestorage.com',
      pathStyle: true,
    });
    const names = (await listSecrets(storage)).map((e) => e.name);
    expect(names).toEqual([
      's3.r2.access_key_id',
      's3.r2.endpoint',
      's3.r2.path_style',
      's3.r2.region',
      's3.r2.secret_access_key',
    ]);
  });
});

// ----------------- setSecret / deleteSecret -----------------

describe('setSecret / deleteSecret', () => {
  let storage: MemStorage;
  beforeEach(() => {
    storage = new MemStorage();
  });

  it('writes the value and the _DOMAINS pair', async () => {
    await setSecret(storage, 'TOKEN', 'abc', ['*.example.com']);
    const all = await storage.get(null);
    expect(all['TOKEN']).toBe('abc');
    expect(all['TOKEN_DOMAINS']).toBe('*.example.com');
  });

  it('joins multiple domain patterns with comma (no space)', async () => {
    await setSecret(storage, 'X', 'v', ['a.com', '*.b.com', 'c.com']);
    const all = await storage.get(null);
    expect(all['X_DOMAINS']).toBe('a.com,*.b.com,c.com');
  });

  it('overwrites an existing secret', async () => {
    await setSecret(storage, 'X', 'old', ['old.com']);
    await setSecret(storage, 'X', 'new', ['new.com']);
    const all = await storage.get(null);
    expect(all['X']).toBe('new');
    expect(all['X_DOMAINS']).toBe('new.com');
  });

  it('removes both the value and _DOMAINS on delete', async () => {
    await setSecret(storage, 'X', 'v', ['a.com']);
    await deleteSecret(storage, 'X');
    const all = await storage.get(null);
    expect(all['X']).toBeUndefined();
    expect(all['X_DOMAINS']).toBeUndefined();
  });
});

// ----------------- deriveS3Domains -----------------

describe('deriveS3Domains', () => {
  it('returns *.amazonaws.com when endpoint is empty', () => {
    expect(deriveS3Domains(undefined)).toEqual(['*.amazonaws.com']);
    expect(deriveS3Domains('')).toEqual(['*.amazonaws.com']);
  });

  it('wildcards the bucket subdomain layer for R2-style endpoints', () => {
    expect(deriveS3Domains('https://account.r2.cloudflarestorage.com')).toEqual([
      '*.r2.cloudflarestorage.com',
    ]);
  });

  it('wildcards for AWS-style endpoints (regional override)', () => {
    expect(deriveS3Domains('https://s3.us-west-2.amazonaws.com')).toEqual([
      '*.us-west-2.amazonaws.com',
    ]);
  });

  it('returns the host as-is for two-part hostnames', () => {
    expect(deriveS3Domains('https://localhost.test:9000')).toEqual(['localhost.test:9000']);
  });

  it('falls back to *.amazonaws.com for unparseable endpoints', () => {
    expect(deriveS3Domains('not a url')).toEqual(['*.amazonaws.com']);
  });
});

// ----------------- S3 profile validation + save -----------------

describe('validateS3ProfileInput', () => {
  it('rejects empty profile name', () => {
    expect(validateS3ProfileInput({ profile: '', accessKey: 'a', secretKey: 's' }).ok).toBe(false);
  });

  it('rejects malformed profile name (regex)', () => {
    const cases = ['a/b', 'a b', 'a\\b', "a'b", 'a;b'];
    for (const profile of cases) {
      expect(
        validateS3ProfileInput({ profile, accessKey: 'a', secretKey: 's' }).ok,
        `should reject ${profile}`
      ).toBe(false);
    }
  });

  it('accepts the allowed character class', () => {
    const cases = ['aws', 'r2', 'my.profile', 'my_profile', 'my-profile', 'AWS-Prod-2024'];
    for (const profile of cases) {
      expect(PROFILE_RE.test(profile), `should accept ${profile}`).toBe(true);
      expect(
        validateS3ProfileInput({ profile, accessKey: 'a', secretKey: 's' }).ok,
        `validate should accept ${profile}`
      ).toBe(true);
    }
  });

  it('rejects empty access key', () => {
    expect(validateS3ProfileInput({ profile: 'aws', accessKey: '', secretKey: 's' }).ok).toBe(
      false
    );
  });

  it('rejects empty secret key', () => {
    expect(validateS3ProfileInput({ profile: 'aws', accessKey: 'a', secretKey: '' }).ok).toBe(
      false
    );
  });

  it('uses explicit domains when provided', () => {
    const v = validateS3ProfileInput({
      profile: 'aws',
      accessKey: 'a',
      secretKey: 's',
      domains: ['*.example.com'],
    });
    expect(v.ok).toBe(true);
    expect(v.resolvedDomains).toEqual(['*.example.com']);
  });

  it('derives domains from endpoint when none provided', () => {
    const v = validateS3ProfileInput({
      profile: 'r2',
      accessKey: 'a',
      secretKey: 's',
      endpoint: 'https://account.r2.cloudflarestorage.com',
    });
    expect(v.ok).toBe(true);
    expect(v.resolvedDomains).toEqual(['*.r2.cloudflarestorage.com']);
  });

  it('falls back to *.amazonaws.com when no endpoint and no domains', () => {
    const v = validateS3ProfileInput({ profile: 'aws', accessKey: 'a', secretKey: 's' });
    expect(v.ok).toBe(true);
    expect(v.resolvedDomains).toEqual(['*.amazonaws.com']);
  });
});

describe('saveS3Profile', () => {
  let storage: MemStorage;
  beforeEach(() => {
    storage = new MemStorage();
  });

  it('writes only the required pair when optional fields are omitted', async () => {
    const v = await saveS3Profile(storage, {
      profile: 'aws',
      accessKey: 'AKIA1',
      secretKey: 'sak',
    });
    expect(v.ok).toBe(true);
    const all = await storage.get(null);
    expect(all['s3.aws.access_key_id']).toBe('AKIA1');
    expect(all['s3.aws.secret_access_key']).toBe('sak');
    expect(all['s3.aws.region']).toBeUndefined();
    expect(all['s3.aws.endpoint']).toBeUndefined();
    expect(all['s3.aws.path_style']).toBeUndefined();
    // Domain wildcard auto-derived from no-endpoint default.
    expect(all['s3.aws.access_key_id_DOMAINS']).toBe('*.amazonaws.com');
  });

  it('writes all fields when all provided', async () => {
    await saveS3Profile(storage, {
      profile: 'r2',
      accessKey: 'k',
      secretKey: 's',
      region: 'auto',
      endpoint: 'https://account.r2.cloudflarestorage.com',
      pathStyle: true,
    });
    const all = await storage.get(null);
    expect(all['s3.r2.region']).toBe('auto');
    expect(all['s3.r2.endpoint']).toBe('https://account.r2.cloudflarestorage.com');
    expect(all['s3.r2.path_style']).toBe('true');
  });

  it('removes a previously-set path_style when re-saved without it (no stale config)', async () => {
    await saveS3Profile(storage, {
      profile: 'r2',
      accessKey: 'k',
      secretKey: 's',
      pathStyle: true,
    });
    expect((await storage.get('s3.r2.path_style'))['s3.r2.path_style']).toBe('true');
    // Re-save with pathStyle=false — should remove the stale entry.
    await saveS3Profile(storage, {
      profile: 'r2',
      accessKey: 'k',
      secretKey: 's',
      pathStyle: false,
    });
    expect((await storage.get('s3.r2.path_style'))['s3.r2.path_style']).toBeUndefined();
  });

  it('returns the validation error on bad input without writing', async () => {
    const v = await saveS3Profile(storage, {
      profile: 'a/b',
      accessKey: 'k',
      secretKey: 's',
    });
    expect(v.ok).toBe(false);
    expect(await listSecrets(storage)).toEqual([]);
  });
});

// ----------------- Custom secrets -----------------

describe('validateCustomSecretInput', () => {
  it('rejects missing name', () => {
    expect(validateCustomSecretInput({ name: '', value: 'v', domains: ['x'] }).ok).toBe(false);
  });
  it('rejects missing value', () => {
    expect(validateCustomSecretInput({ name: 'n', value: '', domains: ['x'] }).ok).toBe(false);
  });
  it('rejects empty domain list', () => {
    expect(validateCustomSecretInput({ name: 'n', value: 'v', domains: [] }).ok).toBe(false);
  });
  it('accepts complete input', () => {
    expect(
      validateCustomSecretInput({ name: 'TOKEN', value: 'v', domains: ['api.github.com'] }).ok
    ).toBe(true);
  });
});

describe('saveCustomSecret', () => {
  let storage: MemStorage;
  beforeEach(() => {
    storage = new MemStorage();
  });

  it('writes the secret + domains pair', async () => {
    const v = await saveCustomSecret(storage, {
      name: 'GITHUB_TOKEN',
      value: 'ghp_abc',
      domains: ['api.github.com', '*.github.com'],
    });
    expect(v.ok).toBe(true);
    const list = await listSecrets(storage);
    expect(list).toEqual([{ name: 'GITHUB_TOKEN', domains: ['api.github.com', '*.github.com'] }]);
  });

  it('does not write when validation fails', async () => {
    await saveCustomSecret(storage, { name: '', value: 'v', domains: ['x'] });
    expect(await listSecrets(storage)).toEqual([]);
  });
});
