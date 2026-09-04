/** Canonical NAME=value / NAME_DOMAINS=csv secret-storage schema. */

export const DOMAINS_SUFFIX = '_DOMAINS';

export interface EnvEntry {
  key: string;
  value: string;
}

export interface SecretEnvEntry {
  name: string;
  value: string;
  domains: string[];
}

export function parseDomainsCsv(raw: string): string[] {
  return raw
    .split(',')
    .map((domain) => domain.trim())
    .filter((domain) => domain.length > 0);
}

/** Pair values with non-empty domain companions, preserving first-name order. */
export function pairEnvEntriesToSecrets(entries: EnvEntry[]): SecretEnvEntry[] {
  const values = new Map<string, string>();
  const domains = new Map<string, string[]>();
  const order: string[] = [];

  for (const entry of entries) {
    if (entry.key.endsWith(DOMAINS_SUFFIX)) {
      const name = entry.key.slice(0, -DOMAINS_SUFFIX.length);
      if (name) domains.set(name, parseDomainsCsv(entry.value));
    } else {
      if (!values.has(entry.key)) order.push(entry.key);
      values.set(entry.key, entry.value);
    }
  }

  return order.flatMap((name) => {
    const value = values.get(name);
    const allowedDomains = domains.get(name);
    return value !== undefined && allowedDomains?.length
      ? [{ name, value, domains: allowedDomains }]
      : [];
  });
}

/**
 * Secret values are stored one per line, so a value carrying a line break
 * cannot survive a `serialize` → `parse` round-trip: `serializeEnvFile` quotes
 * it with a real LF inside the quotes and `parseEnvFile` then splits on `\n`,
 * keeping the unbalanced first line and dropping the rest. Writers reject such
 * a value at the boundary instead of silently truncating it (issue #2828).
 *
 * Mirrored by `EnvFileFormat.isSingleLineValue` in
 * `packages/swift-server/Sources/Keychain/EnvFileFormat.swift`; both sides are
 * pinned by the cross-implementation vectors.
 */
export function isSingleLineSecretValue(value: string): boolean {
  return !/[\n\r]/.test(value);
}

/** The single rejection message both servers return for a multiline value. */
export function multilineSecretValueError(name: string): string {
  return `Secret "${name}" value cannot contain newlines; the secret store is line-oriented and would truncate it to the first line`;
}

/** Parse the shared, deliberately small .env subset used for secret storage. */
export function parseEnvFile(content: string): EnvEntry[] {
  const entries: EnvEntry[] = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) continue;

    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) entries.push({ key, value });
  }
  return entries;
}

/** Parse assignment lines while preserving every character after the first `=`. */
export function parseEnvFilePreservingValues(content: string): EnvEntry[] {
  const entries: EnvEntry[] = [];
  for (const raw of content.split('\n')) {
    const line = raw.trimStart();
    if (line === '' || line.startsWith('#')) continue;
    const eqIndex = raw.indexOf('=');
    if (eqIndex === -1) continue;

    const key = raw.slice(0, eqIndex).trim();
    if (key) entries.push({ key, value: raw.slice(eqIndex + 1) });
  }
  return entries;
}

/**
 * Serialize entries to the line-oriented `.env` subset.
 *
 * Throws on a value containing a line break rather than emitting a blob that
 * would parse back truncated. This is the fail-closed backstop behind the
 * boundary checks in the two privileged servers' secret routes — no write path
 * can corrupt the store by going around them.
 */
export function serializeEnvFile(entries: EnvEntry[]): string {
  const lines = entries.map(({ key, value }) => {
    if (!isSingleLineSecretValue(value)) throw new Error(multilineSecretValueError(key));
    const needsQuoting = /[\s#"']/.test(value);
    const serialized = needsQuoting ? `"${value.replace(/"/g, '\\"')}"` : value;
    return `${key}=${serialized}`;
  });
  return `${lines.join('\n')}\n`;
}

/** Profile name validation shared by every S3 secret-schema writer. */
export const PROFILE_RE = /^[a-zA-Z0-9._-]+$/;

/** Derive the default authorized-host wildcard for an S3-compatible endpoint. */
export function deriveS3Domains(endpoint: string | undefined): string[] {
  if (!endpoint) return ['*.amazonaws.com'];
  try {
    const url = new URL(endpoint);
    const parts = url.host.split('.');
    return parts.length >= 3 ? [`*.${parts.slice(1).join('.')}`] : [url.host];
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
  error?: string;
  resolvedDomains?: string[];
}

export function validateS3ProfileInput(input: S3ProfileInput): S3ProfileValidation {
  if (!input.profile || !PROFILE_RE.test(input.profile)) {
    return { ok: false, error: 'Profile name must be alphanumeric / dot / underscore / hyphen' };
  }
  if (!input.accessKey) return { ok: false, error: 'Access Key ID is required' };
  if (!input.secretKey) return { ok: false, error: 'Secret Access Key is required' };
  const resolvedDomains =
    input.domains && input.domains.length > 0 ? input.domains : deriveS3Domains(input.endpoint);
  return { ok: true, resolvedDomains };
}
