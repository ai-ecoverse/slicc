// Coverage for `@slicc/shared-ts/oauth-extra-domains-storage` attributed to
// the node-server vitest project. The module is imported (transitively) by
// node-server runtime code via the `@slicc/shared-ts` barrel, but
// node-server's own tests never exercise it, so its coverage rolls up at
// ~2% under the node-server gate while the shared-ts gate covers it ~100%.
// Mirrors the shape of `packages/shared-ts/tests/oauth-extra-domains-storage.test.ts`.

import {
  addOAuthExtraDomain,
  clearOAuthExtras,
  type LocalStorageLike,
  OAUTH_EXTRA_DOMAINS_KEY,
  readOAuthExtras,
  removeOAuthExtraDomain,
  writeOAuthExtras,
} from '@slicc/shared-ts';
import { beforeEach, describe, expect, it } from 'vitest';

function makeStorage(initial?: Record<string, string>): LocalStorageLike & {
  data: Record<string, string>;
} {
  const data: Record<string, string> = { ...initial };
  return {
    data,
    getItem: (key: string) => (key in data ? data[key] : null),
    setItem: (key: string, value: string) => {
      data[key] = value;
    },
  };
}

function makeQuotaStorage(): LocalStorageLike {
  return {
    getItem: () => null,
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
  };
}

describe('oauth-extra-domains storage (node-server coverage attribution)', () => {
  let storage: ReturnType<typeof makeStorage>;

  beforeEach(() => {
    storage = makeStorage();
  });

  describe('readOAuthExtras', () => {
    it('returns an empty object when the key is missing', () => {
      expect(readOAuthExtras(storage)).toEqual({});
    });

    it('returns an empty object for malformed JSON (try/catch path)', () => {
      storage.data[OAUTH_EXTRA_DOMAINS_KEY] = '{not json';
      expect(readOAuthExtras(storage)).toEqual({});
    });

    it('returns an empty object when JSON parses to null', () => {
      storage.data[OAUTH_EXTRA_DOMAINS_KEY] = 'null';
      expect(readOAuthExtras(storage)).toEqual({});
    });

    it('returns an empty object when JSON parses to an array (not an object)', () => {
      storage.data[OAUTH_EXTRA_DOMAINS_KEY] = JSON.stringify(['nope']);
      expect(readOAuthExtras(storage)).toEqual({});
    });

    it('returns an empty object when JSON parses to a primitive', () => {
      storage.data[OAUTH_EXTRA_DOMAINS_KEY] = JSON.stringify(42);
      expect(readOAuthExtras(storage)).toEqual({});
    });

    it('drops non-array provider values and non-string domain entries', () => {
      storage.data[OAUTH_EXTRA_DOMAINS_KEY] = JSON.stringify({
        adobe: ['admin.da.live', 42, '*.da.live', ''],
        github: 'not-an-array',
        bare: [],
      });
      // `github` is dropped (not an array). `bare` is dropped (cleaned length 0).
      // `adobe` keeps only the non-empty string entries.
      expect(readOAuthExtras(storage)).toEqual({ adobe: ['admin.da.live', '*.da.live'] });
    });
  });

  describe('writeOAuthExtras', () => {
    it('round-trips with readOAuthExtras', () => {
      writeOAuthExtras(storage, { adobe: ['admin.da.live'], github: ['hub.example.com'] });
      expect(JSON.parse(storage.data[OAUTH_EXTRA_DOMAINS_KEY])).toEqual({
        adobe: ['admin.da.live'],
        github: ['hub.example.com'],
      });
      expect(readOAuthExtras(storage)).toEqual({
        adobe: ['admin.da.live'],
        github: ['hub.example.com'],
      });
    });

    it('wraps QuotaExceededError with a descriptive message', () => {
      const quota = makeQuotaStorage();
      expect(() => writeOAuthExtras(quota, { adobe: ['x'] })).toThrow(
        /Failed to persist OAuth extras.*QuotaExceededError/
      );
    });
  });

  describe('addOAuthExtraDomain', () => {
    it('appends a new domain to a fresh provider entry', () => {
      expect(addOAuthExtraDomain(storage, 'adobe', 'admin.da.live')).toEqual({ added: true });
      expect(readOAuthExtras(storage)).toEqual({ adobe: ['admin.da.live'] });
    });

    it('appends a second distinct domain to the existing provider entry', () => {
      addOAuthExtraDomain(storage, 'adobe', 'admin.da.live');
      expect(addOAuthExtraDomain(storage, 'adobe', '*.da.live')).toEqual({ added: true });
      expect(readOAuthExtras(storage)).toEqual({ adobe: ['admin.da.live', '*.da.live'] });
    });

    it('rejects duplicates case-insensitively without rewriting storage', () => {
      addOAuthExtraDomain(storage, 'adobe', 'admin.da.live');
      const before = storage.data[OAUTH_EXTRA_DOMAINS_KEY];
      expect(addOAuthExtraDomain(storage, 'adobe', 'ADMIN.DA.LIVE')).toEqual({
        added: false,
        reason: 'duplicate',
      });
      // Duplicate path bails before writeOAuthExtras, so storage is byte-identical.
      expect(storage.data[OAUTH_EXTRA_DOMAINS_KEY]).toBe(before);
    });

    it('rejects an empty provider id', () => {
      expect(addOAuthExtraDomain(storage, '', 'x.com')).toEqual({
        added: false,
        reason: 'provider and domain required',
      });
    });

    it('rejects an empty domain', () => {
      expect(addOAuthExtraDomain(storage, 'adobe', '')).toEqual({
        added: false,
        reason: 'provider and domain required',
      });
    });

    it('returns {added:false, reason} when storage throws (QuotaExceededError path)', () => {
      const quota = makeQuotaStorage();
      const result = addOAuthExtraDomain(quota, 'adobe', 'admin.da.live');
      expect(result.added).toBe(false);
      expect(result.reason).toMatch(/Failed to persist OAuth extras/);
    });
  });

  describe('removeOAuthExtraDomain', () => {
    it('removes a matching entry case-insensitively', () => {
      writeOAuthExtras(storage, { adobe: ['admin.da.live', '*.da.live'] });
      expect(removeOAuthExtraDomain(storage, 'adobe', 'ADMIN.DA.LIVE')).toEqual({ removed: true });
      expect(readOAuthExtras(storage)).toEqual({ adobe: ['*.da.live'] });
    });

    it('returns {removed:false} and leaves storage untouched when nothing matches', () => {
      writeOAuthExtras(storage, { adobe: ['admin.da.live'] });
      const before = storage.data[OAUTH_EXTRA_DOMAINS_KEY];
      expect(removeOAuthExtraDomain(storage, 'adobe', 'not-there.com')).toEqual({
        removed: false,
      });
      expect(storage.data[OAUTH_EXTRA_DOMAINS_KEY]).toBe(before);
      expect(readOAuthExtras(storage)).toEqual({ adobe: ['admin.da.live'] });
    });

    it('drops the provider entry entirely when the last domain is removed', () => {
      writeOAuthExtras(storage, { adobe: ['admin.da.live'], github: ['hub.example.com'] });
      removeOAuthExtraDomain(storage, 'adobe', 'admin.da.live');
      expect(readOAuthExtras(storage)).toEqual({ github: ['hub.example.com'] });
    });

    it('treats an unknown provider as a no-op', () => {
      writeOAuthExtras(storage, { github: ['hub.example.com'] });
      expect(removeOAuthExtraDomain(storage, 'adobe', 'admin.da.live')).toEqual({
        removed: false,
      });
      expect(readOAuthExtras(storage)).toEqual({ github: ['hub.example.com'] });
    });
  });

  describe('clearOAuthExtras', () => {
    it('removes a single provider without affecting others', () => {
      writeOAuthExtras(storage, { adobe: ['admin.da.live'], github: ['hub.example.com'] });
      clearOAuthExtras(storage, 'adobe');
      expect(readOAuthExtras(storage)).toEqual({ github: ['hub.example.com'] });
    });

    it('is a no-op for an unknown provider id', () => {
      writeOAuthExtras(storage, { github: ['hub.example.com'] });
      clearOAuthExtras(storage, 'adobe');
      expect(readOAuthExtras(storage)).toEqual({ github: ['hub.example.com'] });
    });
  });
});
