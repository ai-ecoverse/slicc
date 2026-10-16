const DB_NAME = 'slicc-secrets';
const DB_VERSION = 1;
const STORE_NAME = 'keys';
const KEY_ID = 'aes-gcm-secrets';

export const UNREADABLE_SECRET = Symbol.for('slicc:unreadable-secret');

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB not available'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
}

async function getOrCreateKey(): Promise<CryptoKey> {
  const db = await openDb();
  try {
    const existing = await new Promise<CryptoKey | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(KEY_ID);
      req.onsuccess = () => resolve(req.result as CryptoKey | undefined);
      req.onerror = () => reject(req.error);
    });
    if (existing) return existing;

    const candidate = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);

    return await new Promise<CryptoKey>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const getReq = store.get(KEY_ID);
      getReq.onsuccess = () => {
        if (getReq.result) {
          resolve(getReq.result as CryptoKey);
          return;
        }
        const putReq = store.put(candidate, KEY_ID);
        putReq.onsuccess = () => resolve(candidate);
        putReq.onerror = () => reject(putReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

let keyPromise: Promise<CryptoKey> | null = null;
function cachedKey(): Promise<CryptoKey> {
  if (!keyPromise) keyPromise = getOrCreateKey();
  return keyPromise;
}

interface EncryptedValue {
  ct: string;
  iv: string;
}

export function isEncryptedValue(v: unknown): v is EncryptedValue {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as EncryptedValue).ct === 'string' &&
    typeof (v as EncryptedValue).iv === 'string'
  );
}

function toBase64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function fromBase64(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr.buffer;
}

export async function encryptValue(plaintext: string): Promise<EncryptedValue> {
  const key = await cachedKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  return { ct: toBase64(ct), iv: toBase64(iv.buffer) };
}

export async function decryptValue(
  encrypted: EncryptedValue
): Promise<string | typeof UNREADABLE_SECRET> {
  try {
    const key = await cachedKey();
    const plainBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(encrypted.iv) },
      key,
      fromBase64(encrypted.ct)
    );
    return new TextDecoder().decode(plainBuf);
  } catch {
    return UNREADABLE_SECRET;
  }
}

import { DOMAINS_SUFFIX } from '@slicc/shared-ts';

export async function migrateSecretsToEncrypted(): Promise<void> {
  const all = await chrome.storage.local.get(null);
  const candidates: string[] = [];
  for (const [key, value] of Object.entries(all)) {
    if (typeof value !== 'string') continue;
    if (key.endsWith(DOMAINS_SUFFIX)) continue;
    if (!(key + DOMAINS_SUFFIX in all)) continue;
    candidates.push(key);
  }

  for (const key of candidates) {
    const fresh = await chrome.storage.local.get(key);
    const value = fresh[key];
    if (typeof value !== 'string') continue;
    const encrypted = await encryptValue(value);

    const again = (await chrome.storage.local.get(key))[key];
    if (again !== value) continue;
    await chrome.storage.local.set({ [key]: encrypted });
  }
}

import type { SecretsStorageItems, StorageArea } from './secrets-storage.js';

let migrationPromise: Promise<void> | null = null;
function ensureMigrated(): Promise<void> {
  if (!migrationPromise) {
    migrationPromise = migrateSecretsToEncrypted().catch((err) => {
      migrationPromise = null;
      console.error('[slicc] secrets migration failed', err);
      throw err;
    });
  }
  return migrationPromise;
}

export const encryptedStorage: StorageArea = {
  async get(keys?: null | string | string[]): Promise<SecretsStorageItems> {
    await ensureMigrated();
    const raw = await chrome.storage.local.get(keys);
    const result: SecretsStorageItems = {};
    for (const [key, value] of Object.entries(raw)) {
      if (isEncryptedValue(value)) {
        const decrypted = await decryptValue(value);
        if (decrypted === UNREADABLE_SECRET) {
          continue;
        }
        result[key] = decrypted;
      } else {
        result[key] = value;
      }
    }
    return result;
  },

  async set(items: SecretsStorageItems): Promise<void> {
    await ensureMigrated();
    const encrypted: SecretsStorageItems = {};
    for (const [key, value] of Object.entries(items)) {
      if (typeof value === 'string' && !key.endsWith(DOMAINS_SUFFIX)) {
        encrypted[key] = await encryptValue(value);
      } else {
        encrypted[key] = value;
      }
    }
    await chrome.storage.local.set(encrypted);
  },

  async remove(keys: string | string[]): Promise<void> {
    await ensureMigrated();
    await chrome.storage.local.remove(keys);
  },
};

export function isValueEncrypted(value: unknown): boolean {
  return isEncryptedValue(value);
}

import { pairEnvEntriesToSecrets } from '@slicc/shared-ts';

export interface UnreadableSecretEntry {
  name: string;
  domains: string[];
  unreadable: true;
}

export async function listSecretsIncludingUnreadable(): Promise<
  Array<{ name: string; domains: string[]; unreadable: boolean }>
> {
  await ensureMigrated();
  const raw = await chrome.storage.local.get(null);
  const readable: Array<{ key: string; value: string }> = [];
  const unreadableNames = new Set<string>();

  for (const [key, value] of Object.entries(raw)) {
    if (key.endsWith(DOMAINS_SUFFIX)) {
      if (typeof value === 'string') readable.push({ key, value });
      continue;
    }
    if (isEncryptedValue(value)) {
      const decrypted = await decryptValue(value);
      if (decrypted === UNREADABLE_SECRET) {
        unreadableNames.add(key);
      } else {
        readable.push({ key, value: decrypted });
      }
    } else if (typeof value === 'string') {
      readable.push({ key, value });
    }
  }

  const paired = pairEnvEntriesToSecrets(readable);
  const result: Array<{ name: string; domains: string[]; unreadable: boolean }> = paired.map(
    (e) => ({ name: e.name, domains: e.domains, unreadable: false })
  );

  for (const name of unreadableNames) {
    const domainsKey = name + DOMAINS_SUFFIX;
    const domainsRaw = raw[domainsKey];
    const domains = typeof domainsRaw === 'string' ? domainsRaw.split(',').filter(Boolean) : [];
    result.push({ name, domains, unreadable: true });
  }

  result.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}
