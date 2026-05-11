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

const DOMAINS_SUFFIX = '_DOMAINS';

/** Profile name validation — matches the server-side regex in sign-and-forward.ts. */
export const PROFILE_RE = /^[a-zA-Z0-9._-]+$/;

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
  const entries: SecretEntry[] = [];
  for (const key of Object.keys(all)) {
    if (key.endsWith(DOMAINS_SUFFIX)) continue;
    if (typeof all[key] !== 'string') continue;
    const domainsKey = key + DOMAINS_SUFFIX;
    const raw = all[domainsKey];
    if (typeof raw !== 'string') continue;
    const domains = raw
      .split(',')
      .map((d) => d.trim())
      .filter(Boolean);
    if (domains.length === 0) continue;
    entries.push({ name: key, domains });
  }
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
 * Derive a sensible default domain wildcard from an S3 endpoint URL.
 *
 * - No endpoint → `*.amazonaws.com` (covers AWS S3)
 * - Endpoint with hostname like `account.r2.cloudflarestorage.com` →
 *   `*.r2.cloudflarestorage.com` (wildcards the bucket subdomain layer
 *   so the same domain pattern fits AWS-style virtual-hosted requests)
 * - Two-part hostname like `localhost.test` → use as-is
 * - Anything that doesn't parse as a URL → fall back to AWS default
 */
export function deriveS3Domains(endpoint: string | undefined): string[] {
  if (!endpoint) return ['*.amazonaws.com'];
  try {
    const url = new URL(endpoint);
    const parts = url.host.split('.');
    if (parts.length >= 3) {
      return [`*.${parts.slice(1).join('.')}`];
    }
    return [url.host];
  } catch {
    return ['*.amazonaws.com'];
  }
}

export interface S3ProfileInput {
  profile: string;
  accessKey: string;
  secretKey: string;
  region?: string;
  endpoint?: string;
  pathStyle?: boolean;
  domains?: string[];
}

export interface S3ProfileValidation {
  ok: boolean;
  /** When `ok === false`, an actionable message for the form. */
  error?: string;
  /** When `ok === true`, the resolved domain list applied to every key. */
  resolvedDomains?: string[];
}

export function validateS3ProfileInput(input: S3ProfileInput): S3ProfileValidation {
  if (!input.profile || !PROFILE_RE.test(input.profile)) {
    return {
      ok: false,
      error: 'Profile name must be alphanumeric / dot / underscore / hyphen',
    };
  }
  if (!input.accessKey) {
    return { ok: false, error: 'Access Key ID is required' };
  }
  if (!input.secretKey) {
    return { ok: false, error: 'Secret Access Key is required' };
  }

  const resolvedDomains =
    input.domains && input.domains.length > 0 ? input.domains : deriveS3Domains(input.endpoint);
  if (resolvedDomains.length === 0) {
    return { ok: false, error: 'At least one domain pattern is required' };
  }
  return { ok: true, resolvedDomains };
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
  const entries: SecretEntryWithValue[] = [];
  for (const key of Object.keys(all)) {
    if (key.endsWith(DOMAINS_SUFFIX)) continue;
    if (typeof all[key] !== 'string') continue;
    const domainsKey = key + DOMAINS_SUFFIX;
    const raw = all[domainsKey];
    if (typeof raw !== 'string') continue;
    const domains = raw
      .split(',')
      .map((d) => d.trim())
      .filter(Boolean);
    if (domains.length === 0) continue;
    entries.push({ name: key, value: all[key] as string, domains });
  }
  return entries;
}
