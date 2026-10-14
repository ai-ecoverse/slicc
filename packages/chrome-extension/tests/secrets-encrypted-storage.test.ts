/**
 * Tests for B-SEC1 encrypted secret storage.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Minimal chrome.storage.local mock
// ---------------------------------------------------------------------------
let storageMap: Record<string, unknown> = {};

const fakeLocalStorage = {
  get: async (keys?: null | string | string[]) => {
    if (keys === null || keys === undefined) return { ...storageMap };
    if (typeof keys === 'string') {
      return keys in storageMap ? { [keys]: storageMap[keys] } : {};
    }
    const result: Record<string, unknown> = {};
    for (const k of keys) {
      if (k in storageMap) result[k] = storageMap[k];
    }
    return result;
  },
  set: async (items: Record<string, unknown>) => {
    Object.assign(storageMap, items);
  },
  remove: async (keys: string | string[]) => {
    const arr = typeof keys === 'string' ? [keys] : keys;
    for (const k of arr) delete storageMap[k];
  },
};

(globalThis as any).chrome = {
  storage: { local: fakeLocalStorage },
  runtime: { id: 'test-ext' },
};

async function loadModule() {
  return import('../src/secrets-encrypted-storage.js');
}

describe('encrypted secret storage', () => {
  beforeEach(() => {
    storageMap = {};
    vi.resetModules();
  });

  it('encrypts and decrypts a value round-trip', async () => {
    const { encryptValue, decryptValue } = await loadModule();
    const encrypted = await encryptValue('ghp_realtoken123');
    expect(encrypted).toHaveProperty('ct');
    expect(encrypted).toHaveProperty('iv');
    expect(encrypted.ct).not.toBe('ghp_realtoken123');
    const decrypted = await decryptValue(encrypted);
    expect(decrypted).toBe('ghp_realtoken123');
  });

  it('isValueEncrypted returns true for encrypted values', async () => {
    const { encryptValue, isValueEncrypted } = await loadModule();
    const encrypted = await encryptValue('test');
    expect(isValueEncrypted(encrypted)).toBe(true);
    expect(isValueEncrypted('plaintext')).toBe(false);
    expect(isValueEncrypted(null)).toBe(false);
  });

  it('migrates plaintext secrets to encrypted format', async () => {
    const { migrateSecretsToEncrypted, isValueEncrypted } = await loadModule();
    storageMap = {
      GITHUB_TOKEN: 'ghp_secret123',
      GITHUB_TOKEN_DOMAINS: 'api.github.com,*.github.com',
      AWS_KEY: 'AKIA_secret456',
      AWS_KEY_DOMAINS: '*.amazonaws.com',
    };
    await migrateSecretsToEncrypted();
    expect(isValueEncrypted(storageMap['GITHUB_TOKEN'])).toBe(true);
    expect(isValueEncrypted(storageMap['AWS_KEY'])).toBe(true);
    expect(storageMap['GITHUB_TOKEN_DOMAINS']).toBe('api.github.com,*.github.com');
  });

  it('plaintext canary is unreadable via chrome.storage.local.get(null) after migration', async () => {
    const { migrateSecretsToEncrypted, isValueEncrypted } = await loadModule();
    storageMap = {
      CANARY_SECRET: 'super_secret_value',
      CANARY_SECRET_DOMAINS: '*.example.com',
    };
    await migrateSecretsToEncrypted();
    const raw = await fakeLocalStorage.get(null);
    expect(typeof raw['CANARY_SECRET']).not.toBe('string');
    expect(isValueEncrypted(raw['CANARY_SECRET'])).toBe(true);
    expect(JSON.stringify(raw['CANARY_SECRET'])).not.toContain('super_secret_value');
  });

  it('migration is crash-safe: partially migrated storage completed on next run', async () => {
    const { encryptValue, decryptValue, isValueEncrypted, migrateSecretsToEncrypted } =
      await loadModule();
    const encA = await encryptValue('value_a');
    storageMap = {
      KEY_A: encA,
      KEY_A_DOMAINS: '*.a.com',
      KEY_B: 'plaintext_b',
      KEY_B_DOMAINS: '*.b.com',
    };
    await migrateSecretsToEncrypted();
    expect(isValueEncrypted(storageMap['KEY_A'])).toBe(true);
    expect(await decryptValue(storageMap['KEY_A'] as any)).toBe('value_a');
    expect(isValueEncrypted(storageMap['KEY_B'])).toBe(true);
    expect(await decryptValue(storageMap['KEY_B'] as any)).toBe('plaintext_b');
  });

  it('migration is concurrent-safe: two simultaneous migrations do not double-encrypt', async () => {
    const { decryptValue, migrateSecretsToEncrypted, isValueEncrypted } = await loadModule();
    storageMap = { RACE_KEY: 'race_value', RACE_KEY_DOMAINS: '*.race.com' };
    await Promise.all([migrateSecretsToEncrypted(), migrateSecretsToEncrypted()]);
    expect(isValueEncrypted(storageMap['RACE_KEY'])).toBe(true);
    expect(await decryptValue(storageMap['RACE_KEY'] as any)).toBe('race_value');
  });

  it('decryption failure returns UNREADABLE_SECRET, preserves ciphertext', async () => {
    const { decryptValue, UNREADABLE_SECRET } = await loadModule();
    const corrupt = { ct: 'AAAA', iv: 'BBBB' };
    storageMap = { CORRUPT_KEY: corrupt, CORRUPT_KEY_DOMAINS: '*.test.com' };
    const result = await decryptValue(corrupt);
    expect(result).toBe(UNREADABLE_SECRET);
    expect(storageMap['CORRUPT_KEY']).toBe(corrupt);
  });

  it('encryptedStorage.get skips unreadable secrets (ciphertext preserved)', async () => {
    const { encryptValue, encryptedStorage } = await loadModule();
    const corrupt = { ct: 'AAAA', iv: 'BBBB' };
    const good = await encryptValue('good_value');
    storageMap = {
      BROKEN_KEY: corrupt,
      BROKEN_KEY_DOMAINS: '*.broken.com',
      GOOD_KEY: good,
      GOOD_KEY_DOMAINS: '*.good.com',
    };
    const result = await encryptedStorage.get(null);
    expect(result['GOOD_KEY']).toBe('good_value');
    expect(result['BROKEN_KEY']).toBeUndefined();
    expect(storageMap['BROKEN_KEY']).toBe(corrupt);
  });

  it('encryptedStorage.set encrypts values transparently', async () => {
    const { encryptedStorage, isValueEncrypted } = await loadModule();
    await encryptedStorage.set({ NEW_KEY: 'secret', NEW_KEY_DOMAINS: '*.new.com' });
    expect(isValueEncrypted(storageMap['NEW_KEY'])).toBe(true);
    expect(storageMap['NEW_KEY_DOMAINS']).toBe('*.new.com');
  });

  it('encryptedStorage round-trip: set then get', async () => {
    const { encryptedStorage } = await loadModule();
    await encryptedStorage.set({ RT: 'original', RT_DOMAINS: '*.rt.com' });
    const result = await encryptedStorage.get('RT');
    expect(result['RT']).toBe('original');
  });

  it('encryptedStorage.remove deletes keys', async () => {
    const { encryptedStorage } = await loadModule();
    storageMap = { DEL: 'val', DEL_DOMAINS: '*.x.com' };
    await encryptedStorage.remove(['DEL', 'DEL_DOMAINS']);
    expect(storageMap).toEqual({});
  });

  it('migration preserves existing users secrets', async () => {
    const { encryptedStorage, migrateSecretsToEncrypted } = await loadModule();
    storageMap = {
      GITHUB_TOKEN: 'ghp_real_user_token',
      GITHUB_TOKEN_DOMAINS: 'api.github.com',
      's3.default.secret_access_key': 'wJalrXUtnFEMI/K7MDENG',
      's3.default.secret_access_key_DOMAINS': '*.s3.amazonaws.com',
    };
    await migrateSecretsToEncrypted();
    const result = await encryptedStorage.get(null);
    expect(result['GITHUB_TOKEN']).toBe('ghp_real_user_token');
    expect(result['s3.default.secret_access_key']).toBe('wJalrXUtnFEMI/K7MDENG');
    const raw = await fakeLocalStorage.get(null);
    expect(typeof raw['GITHUB_TOKEN']).not.toBe('string');
  });

  it('listSecretsIncludingUnreadable surfaces broken entries', async () => {
    const { encryptValue, listSecretsIncludingUnreadable } = await loadModule();
    const corrupt = { ct: 'AAAA', iv: 'BBBB' };
    const good = await encryptValue('good_value');
    storageMap = {
      BROKEN_KEY: corrupt,
      BROKEN_KEY_DOMAINS: '*.broken.com,api.broken.com',
      GOOD_KEY: good,
      GOOD_KEY_DOMAINS: '*.good.com',
    };
    const entries = await listSecretsIncludingUnreadable();
    const broken = entries.find((e: any) => e.name === 'BROKEN_KEY');
    const goodEntry = entries.find((e: any) => e.name === 'GOOD_KEY');
    expect(broken).toBeDefined();
    expect(broken!.unreadable).toBe(true);
    expect(broken!.domains).toEqual(['*.broken.com', 'api.broken.com']);
    expect(goodEntry).toBeDefined();
    expect(goodEntry!.unreadable).toBe(false);
    expect(storageMap['BROKEN_KEY']).toBe(corrupt);
  });

  it('re-saving an unreadable secret replaces its ciphertext', async () => {
    const { encryptedStorage, listSecretsIncludingUnreadable } = await loadModule();
    const corrupt = { ct: 'AAAA', iv: 'BBBB' };
    storageMap = { FIXME: corrupt, FIXME_DOMAINS: '*.fix.com' };
    const before = await listSecretsIncludingUnreadable();
    expect(before.find((e: any) => e.name === 'FIXME')!.unreadable).toBe(true);
    await encryptedStorage.set({ FIXME: 'new_working_value', FIXME_DOMAINS: '*.fix.com' });
    const after = await listSecretsIncludingUnreadable();
    expect(after.find((e: any) => e.name === 'FIXME')!.unreadable).toBe(false);
    const result = await encryptedStorage.get('FIXME');
    expect(result['FIXME']).toBe('new_working_value');
  });
});
