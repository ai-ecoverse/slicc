/**
 * Encrypted secret storage — keeps secret values out of content-script reach.
 *
 * Content scripts run in the page's origin and CAN read chrome.storage.local,
 * where secrets previously sat in plaintext. This module encrypts every secret
 * value with a non-extractable AES-GCM CryptoKey stored in the extension's
 * own-origin IndexedDB (inaccessible from content-script origins).
 *
 * Schema in chrome.storage.local after migration:
 *   `<name>`           → `{ ct: string, iv: string }`  (base64 ciphertext + IV)
 *   `<name>_DOMAINS`   → `"pattern1,pattern2"`          (plaintext, not sensitive)
 *
 * Failure policy:
 *   - If the CryptoKey is missing or decryption fails, the ciphertext is
 *     preserved. The secret is reported as unreadable (never falls back to
 *     plaintext, never wipes data).
 *   - Migration is crash-safe and concurrent-safe: each key is migrated
 *     individually (write ciphertext, then delete the plaintext form is
 *     implicit — the ciphertext overwrites the plaintext at the same key).
 *     A half-finished migration is idempotent on next run.
 */

const DB_NAME = 'slicc-secrets';
const DB_VERSION = 1;
const STORE_NAME = 'keys';
const KEY_ID = 'aes-gcm-secrets';

/** Sentinel value marking a secret whose ciphertext couldn't be decrypted. */
export const UNREADABLE_SECRET = Symbol.for('slicc:unreadable-secret');

// ---------------------------------------------------------------------------
// IndexedDB key management
// ---------------------------------------------------------------------------

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

/** Get or create the non-extractable AES-GCM key.
 *  Pre-generates a candidate key, then does a synchronous IDB
 *  read-check-write so two contexts cannot each store a different key. */
async function getOrCreateKey(): Promise<CryptoKey> {
  const db = await openDb();
  try {
    // Fast path: read-only check.
    const existing = await new Promise<CryptoKey | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(KEY_ID);
      req.onsuccess = () => resolve(req.result as CryptoKey | undefined);
      req.onerror = () => reject(req.error);
    });
    if (existing) return existing;

    // Generate the key BEFORE opening the write tx — crypto.subtle.generateKey
    // is async and would auto-commit an IDB transaction.
    const candidate = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);

    // Readwrite tx: re-check (another context may have raced) then store.
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

// Cache the key promise so concurrent callers share the same init.
let keyPromise: Promise<CryptoKey> | null = null;
function cachedKey(): Promise<CryptoKey> {
  if (!keyPromise) keyPromise = getOrCreateKey();
  return keyPromise;
}

// ---------------------------------------------------------------------------
// Encrypt / decrypt
// ---------------------------------------------------------------------------

interface EncryptedValue {
  ct: string; // base64 ciphertext
  iv: string; // base64 IV
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

/**
 * Decrypt an encrypted value. Returns the plaintext on success, or
 * `UNREADABLE_SECRET` if decryption fails (key missing, corrupt ciphertext).
 * Never throws — fail-closed means unreadable, not crash.
 */
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

// ---------------------------------------------------------------------------
// Migration — crash-safe, concurrent-safe, idempotent
// ---------------------------------------------------------------------------

import { DOMAINS_SUFFIX } from '@slicc/shared-ts';

/**
 * Migrate existing plaintext secrets to encrypted format.
 *
 * Each key is migrated individually and re-read right before encrypting,
 * so a concurrent CRUD from the secrets page won't be silently overwritten
 * by a stale value. Crash-safe: partial migration resumes on next run.
 */
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
    // Re-read the current value right before encrypting, so a concurrent
    // save from the secrets page is not overwritten with a stale snapshot.
    const fresh = await chrome.storage.local.get(key);
    const value = fresh[key];
    if (typeof value !== 'string') continue; // already encrypted or deleted
    const encrypted = await encryptValue(value);
    await chrome.storage.local.set({ [key]: encrypted });
  }
}

// ---------------------------------------------------------------------------
// Encrypted StorageArea adapter
// ---------------------------------------------------------------------------

import type { SecretsStorageItems, StorageArea } from './secrets-storage.js';

/**
 * A `StorageArea`-compatible wrapper that transparently encrypts/decrypts
 * secret values in chrome.storage.local. Domain keys (_DOMAINS) pass through
 * as plaintext.
 *
 * Decryption failures (key lost, corrupt ciphertext) produce `undefined`
 * for the affected key — the ciphertext stays in storage. The secrets
 * page uses `listSecretsIncludingUnreadable()` to show them with a re-enter
 * prompt; the fetch proxy and mount signing skip them silently.
 */
// Migration gate — every encryptedStorage method awaits this before proceeding.
// This ensures migration runs even when the mount backend or secrets page
// accesses encryptedStorage before the SW's secrets-sw.ts does.
let migrationPromise: Promise<void> | null = null;
function ensureMigrated(): Promise<void> {
  if (!migrationPromise) {
    migrationPromise = migrateSecretsToEncrypted().catch((err) => {
      console.error('[slicc] secrets migration failed', err);
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
          // Preserve ciphertext in storage; surface as undefined to callers.
          // The secrets page detects this and shows a re-enter prompt.
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

/** For testing: check if a value in storage is encrypted (not plaintext). */
export function isValueEncrypted(value: unknown): boolean {
  return isEncryptedValue(value);
}

// ---------------------------------------------------------------------------
// Unreadable-secret support for the secrets page
// ---------------------------------------------------------------------------

import { pairEnvEntriesToSecrets } from '@slicc/shared-ts';

export interface UnreadableSecretEntry {
  name: string;
  domains: string[];
  unreadable: true;
}

/**
 * List secrets including those whose ciphertext can't be decrypted.
 * Readable secrets come with `unreadable: false`; unreadable ones come with
 * `unreadable: true` (name and domains only, no value). The secrets page
 * uses this to show a "re-enter" prompt. The fetch proxy and mount signing
 * use `encryptedStorage.get()` which omits unreadable entries.
 */
export async function listSecretsIncludingUnreadable(): Promise<
  Array<{ name: string; domains: string[]; unreadable: boolean }>
> {
  await ensureMigrated();
  const raw = await chrome.storage.local.get(null);
  const readable: Array<{ key: string; value: string }> = [];
  const unreadableNames = new Set<string>();

  for (const [key, value] of Object.entries(raw)) {
    if (key.endsWith(DOMAINS_SUFFIX)) {
      // Include domain keys so pairEnvEntriesToSecrets can pair them.
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

  // Pair readable entries using the shared pairing logic.
  const paired = pairEnvEntriesToSecrets(readable);
  const result: Array<{ name: string; domains: string[]; unreadable: boolean }> = paired.map(
    (e) => ({ name: e.name, domains: e.domains, unreadable: false })
  );

  // Add unreadable entries (name + domains from _DOMAINS key).
  for (const name of unreadableNames) {
    const domainsKey = name + DOMAINS_SUFFIX;
    const domainsRaw = raw[domainsKey];
    const domains = typeof domainsRaw === 'string' ? domainsRaw.split(',').filter(Boolean) : [];
    result.push({ name, domains, unreadable: true });
  }

  result.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}
