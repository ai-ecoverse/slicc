import { describe, it, expect, beforeEach } from 'vitest';
import {
  OAUTH_EXTRA_DOMAINS_KEY,
  addOAuthExtraDomain,
  clearOAuthExtras,
  readOAuthExtras,
  removeOAuthExtraDomain,
  writeOAuthExtras,
  type LocalStorageLike,
} from '../src/oauth-extra-domains-storage.js';

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

describe('oauth-extra-domains storage (options page <-> side panel)', () => {
  let storage: ReturnType<typeof makeStorage>;

  beforeEach(() => {
    storage = makeStorage();
  });

  it('readOAuthExtras returns empty object when key is missing', () => {
    expect(readOAuthExtras(storage)).toEqual({});
  });

  it('readOAuthExtras returns empty object for malformed JSON', () => {
    storage.data[OAUTH_EXTRA_DOMAINS_KEY] = '{not json';
    expect(readOAuthExtras(storage)).toEqual({});
  });

  it('readOAuthExtras drops non-array values and non-string domain entries', () => {
    storage.data[OAUTH_EXTRA_DOMAINS_KEY] = JSON.stringify({
      adobe: ['admin.da.live', 42, '*.da.live'],
      github: 'not-an-array',
      bare: [],
    });
    expect(readOAuthExtras(storage)).toEqual({ adobe: ['admin.da.live', '*.da.live'] });
  });

  it('writeOAuthExtras + readOAuthExtras round-trip', () => {
    writeOAuthExtras(storage, { adobe: ['admin.da.live'], github: ['hub.example.com'] });
    expect(readOAuthExtras(storage)).toEqual({
      adobe: ['admin.da.live'],
      github: ['hub.example.com'],
    });
  });

  it('addOAuthExtraDomain appends a new domain', () => {
    expect(addOAuthExtraDomain(storage, 'adobe', 'admin.da.live')).toEqual({ added: true });
    expect(readOAuthExtras(storage)).toEqual({ adobe: ['admin.da.live'] });
    expect(addOAuthExtraDomain(storage, 'adobe', '*.da.live')).toEqual({ added: true });
    expect(readOAuthExtras(storage)).toEqual({ adobe: ['admin.da.live', '*.da.live'] });
  });

  it('addOAuthExtraDomain rejects duplicates case-insensitively', () => {
    addOAuthExtraDomain(storage, 'adobe', 'admin.da.live');
    expect(addOAuthExtraDomain(storage, 'adobe', 'ADMIN.DA.LIVE')).toEqual({
      added: false,
      reason: 'duplicate',
    });
    expect(readOAuthExtras(storage)).toEqual({ adobe: ['admin.da.live'] });
  });

  it('addOAuthExtraDomain rejects empty provider or domain', () => {
    expect(addOAuthExtraDomain(storage, '', 'x.com').added).toBe(false);
    expect(addOAuthExtraDomain(storage, 'adobe', '').added).toBe(false);
  });

  it('removeOAuthExtraDomain removes the entry case-insensitively', () => {
    writeOAuthExtras(storage, { adobe: ['admin.da.live', '*.da.live'] });
    expect(removeOAuthExtraDomain(storage, 'adobe', 'ADMIN.DA.LIVE')).toEqual({ removed: true });
    expect(readOAuthExtras(storage)).toEqual({ adobe: ['*.da.live'] });
  });

  it('removeOAuthExtraDomain returns {removed: false} when nothing matches', () => {
    writeOAuthExtras(storage, { adobe: ['admin.da.live'] });
    expect(removeOAuthExtraDomain(storage, 'adobe', 'not-there.com')).toEqual({ removed: false });
    expect(readOAuthExtras(storage)).toEqual({ adobe: ['admin.da.live'] });
  });

  it('removeOAuthExtraDomain drops the provider entry when the last domain goes', () => {
    writeOAuthExtras(storage, { adobe: ['admin.da.live'], github: ['hub.example.com'] });
    removeOAuthExtraDomain(storage, 'adobe', 'admin.da.live');
    expect(readOAuthExtras(storage)).toEqual({ github: ['hub.example.com'] });
  });

  it('clearOAuthExtras removes a single provider without affecting others', () => {
    writeOAuthExtras(storage, { adobe: ['admin.da.live'], github: ['hub.example.com'] });
    clearOAuthExtras(storage, 'adobe');
    expect(readOAuthExtras(storage)).toEqual({ github: ['hub.example.com'] });
  });
});
