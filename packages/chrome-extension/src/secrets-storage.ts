/**
 * Pure logic for the Mount Secrets options page (`secrets.html`).
 *
 * Functions here are independent of the DOM and accept the storage area
 * via parameter — that lets us unit-test against a mocked
 * `chrome.storage.local` without any browser context. The options page
 * (`secrets-entry.ts`) wires this to the real `chrome.storage.local`.
 *
 * Storage schema mirrors the in-shell `secret` command and the SW mount
 * sign-and-forward handler (so settings made on this page are immediately
 * usable by `mount --source s3://...`):
 *
 *   <name>           → string value
 *   <name>_DOMAINS   → comma-separated patterns
 */

import {
  DOMAINS_SUFFIX,
  deriveS3Domains,
  PROFILE_RE,
  pairEnvEntriesToSecrets,
  type S3ProfileInput,
  type S3ProfileValidation,
  validateS3ProfileInput,
} from '@slicc/shared-ts';

export {
  deriveS3Domains,
  PROFILE_RE,
  type S3ProfileInput,
  type S3ProfileValidation,
  validateS3ProfileInput,
};

/**
 * Minimal interface for `chrome.storage.local` that we actually use.
 * Both the production `chrome.storage.local` and a test in-memory mock
 * satisfy this shape.
 */
export interface StorageArea {
  get(keys?: null | string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export interface SecretEntry {
  name: string;
  domains: string[];
}

export async function listSecrets(storage: StorageArea): Promise<SecretEntry[]> {
  const all = await storage.get(null);
  const entries = pairStorageEntries(all).map(({ name, domains }) => ({ name, domains }));
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

export async function setSecret(
  storage: StorageArea,
  name: string,
  value: string,
  domains: string[]
): Promise<void> {
  await storage.set({
    [name]: value,
    [name + DOMAINS_SUFFIX]: domains.join(','),
  });
}

export async function deleteSecret(storage: StorageArea, name: string): Promise<void> {
  await storage.remove([name, name + DOMAINS_SUFFIX]);
}

/**
 * Save an S3 profile as five paired secrets. Required fields produce
 * one pair each; optional fields are written only when provided. The
 * `path_style` key is removed when not set, so an unchecked box on
 * re-save doesn't leave stale config behind.
 */
export async function saveS3Profile(
  storage: StorageArea,
  input: S3ProfileInput
): Promise<S3ProfileValidation> {
  const v = validateS3ProfileInput(input);
  if (!v.ok) return v;
  const domains = v.resolvedDomains!;
  const prefix = `s3.${input.profile}`;

  await setSecret(storage, `${prefix}.access_key_id`, input.accessKey, domains);
  await setSecret(storage, `${prefix}.secret_access_key`, input.secretKey, domains);
  if (input.region) await setSecret(storage, `${prefix}.region`, input.region, domains);
  if (input.endpoint) await setSecret(storage, `${prefix}.endpoint`, input.endpoint, domains);
  if (input.pathStyle === true) {
    await setSecret(storage, `${prefix}.path_style`, 'true', domains);
  } else {
    await deleteSecret(storage, `${prefix}.path_style`);
  }
  return v;
}

export interface CustomSecretInput {
  name: string;
  value: string;
  domains: string[];
}

export interface CustomSecretValidation {
  ok: boolean;
  error?: string;
}

export function validateCustomSecretInput(input: CustomSecretInput): CustomSecretValidation {
  if (!input.name) return { ok: false, error: 'Name is required' };
  if (!input.value) return { ok: false, error: 'Value is required' };
  if (input.domains.length === 0) {
    return { ok: false, error: 'At least one domain pattern is required' };
  }
  return { ok: true };
}

export async function saveCustomSecret(
  storage: StorageArea,
  input: CustomSecretInput
): Promise<CustomSecretValidation> {
  const v = validateCustomSecretInput(input);
  if (!v.ok) return v;
  await setSecret(storage, input.name, input.value, input.domains);
  return v;
}

export interface SecretEntryWithValue {
  name: string;
  value: string;
  domains: string[];
}

/**
 * Returns all secrets with their values included.
 * Same walk as `listSecrets`, but returns `{name, value, domains}[]` for
 * the SW's fetch-proxy unmask map.
 */
export async function listSecretsWithValues(storage: StorageArea): Promise<SecretEntryWithValue[]> {
  const all = await storage.get(null);
  return pairStorageEntries(all);
}

function pairStorageEntries(all: Record<string, unknown>): SecretEntryWithValue[] {
  return pairEnvEntriesToSecrets(
    Object.entries(all).flatMap(([key, value]) =>
      typeof value === 'string' ? [{ key, value }] : []
    )
  );
}
