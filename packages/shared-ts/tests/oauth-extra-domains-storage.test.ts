import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addOAuthExtraDomain,
  clearOAuthExtras,
  type LocalStorageLike,
  OAUTH_EXTRA_DOMAINS_KEY,
  readOAuthExtras,
  removeOAuthExtraDomain,
  writeOAuthExtras,
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

describe('oauth-extra-domains storage — present but unparsable (#4146)', () => {
  const CORRUPT_KEY = `${OAUTH_EXTRA_DOMAINS_KEY}.corrupt`;
  let storage: ReturnType<typeof makeStorage>;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    storage = makeStorage();
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it('moves a truncated store aside before adding, and still adds', () => {
    const raw = '{"adobe":["admin.da.live"],"github":["hub.exa';
    storage.data[OAUTH_EXTRA_DOMAINS_KEY] = raw;
    expect(addOAuthExtraDomain(storage, 'adobe', '*.da.live')).toEqual({ added: true });
    expect(storage.data[CORRUPT_KEY]).toBe(raw);
    expect(readOAuthExtras(storage)).toEqual({ adobe: ['*.da.live'] });
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(String(consoleError.mock.calls[0])).not.toContain('admin.da.live');
  });

  it('treats JSON that is not an object as corrupt', () => {
    storage.data[OAUTH_EXTRA_DOMAINS_KEY] = '["admin.da.live"]';
    clearOAuthExtras(storage, 'adobe');
    expect(storage.data[CORRUPT_KEY]).toBe('["admin.da.live"]');
    expect(storage.data[OAUTH_EXTRA_DOMAINS_KEY]).toBe('{}');
  });

  it('refuses to overwrite when the corrupt value cannot be preserved', () => {
    const raw = '{"adobe":["admin.da.live"';
    storage.data[OAUTH_EXTRA_DOMAINS_KEY] = raw;
    const setItem = storage.setItem;
    storage.setItem = (key, value) => {
      if (key === CORRUPT_KEY) throw new Error('blocked');
      setItem(key, value);
    };
    const result = addOAuthExtraDomain(storage, 'adobe', '*.da.live');
    expect(result.added).toBe(false);
    expect(result.reason).toContain('could not be backed up');
    expect(() => clearOAuthExtras(storage, 'adobe')).toThrow(/nothing was saved/);
    expect(storage.data[OAUTH_EXTRA_DOMAINS_KEY]).toBe(raw);
  });

  it('clearOAuthExtras drops the copy, which may still list the cleared domains', () => {
    const raw = '{"adobe":["admin.da.live"],"git';
    storage.data[OAUTH_EXTRA_DOMAINS_KEY] = raw;
    const removeItem = (key: string) => {
      delete storage.data[key];
    };
    const withRemove = { ...storage, removeItem };

    clearOAuthExtras(withRemove, 'github');
    expect(storage.data[CORRUPT_KEY]).toBe(raw);
    addOAuthExtraDomain(withRemove, 'github', 'hub.example.com');
    expect(storage.data[CORRUPT_KEY]).toBe(raw);
    clearOAuthExtras(withRemove, 'github');
    expect(storage.data[CORRUPT_KEY]).toBeUndefined();
    expect(readOAuthExtras(storage)).toEqual({});
  });

  it('leaves absent and valid stores without a quarantine copy', () => {
    addOAuthExtraDomain(storage, 'adobe', 'admin.da.live');
    addOAuthExtraDomain(storage, 'github', 'hub.example.com');
    expect(readOAuthExtras(storage)).toEqual({
      adobe: ['admin.da.live'],
      github: ['hub.example.com'],
    });
    expect(storage.data[CORRUPT_KEY]).toBeUndefined();
    expect(consoleError).not.toHaveBeenCalled();
  });
});
