// Side-effect-free shared contract for cloud-cone configuration.
// MUST NOT import e2b, node:*, or any runtime substrate — it is imported
// by the browser webapp via the @slicc/cloud-core/cone-config subpath.

export interface OAuthAccount {
  providerId: string;
  kind: 'oauth';
  accessToken: string;
  refreshToken?: string;
  tokenExpiresAt?: number;
  userName?: string;
  baseUrl?: string;
}
export interface ApiKeyAccount {
  providerId: string;
  kind: 'apikey';
  apiKey: string;
  baseUrl?: string;
  deployment?: string;
  apiVersion?: string;
}
export type Account = OAuthAccount | ApiKeyAccount;

export interface SecretEntry {
  name: string;
  value: string;
  domains: string[];
}

export interface ConeConfig {
  model: string;
  accounts: Account[];
  secrets: SecretEntry[];
}

export interface ConeConfigDelta {
  model?: string;
  upsert?: { accounts?: Account[]; secrets?: SecretEntry[] };
  delete?: { providerIds?: string[]; secretNames?: string[] };
}

export interface ConeConfigIndex {
  model: string;
  accountProviderIds: string[];
  accountMeta: Array<{ providerId: string; kind: Account['kind']; tokenExpiresAt?: number }>;
  secretNames: string[];
}

/** Max serialized bundle size (bytes) accepted as a preboot env payload. */
export const MAX_CONE_CONFIG_BYTES = 256 * 1024;

function isStr(v: unknown): v is string {
  return typeof v === 'string';
}

export function validateConeConfig(input: unknown): ConeConfig {
  if (!input || typeof input !== 'object') throw new Error('cone-config: not an object');
  const cfg = input as Record<string, unknown>;
  if (!isStr(cfg.model)) throw new Error('cone-config: model must be a string');
  if (!Array.isArray(cfg.accounts)) throw new Error('cone-config: accounts must be an array');
  if (!Array.isArray(cfg.secrets)) throw new Error('cone-config: secrets must be an array');
  const accounts = cfg.accounts.map((a) => validateAccount(a));
  const secrets = cfg.secrets.map((s) => validateSecret(s));
  return { model: cfg.model, accounts, secrets };
}

function validateAccount(a: unknown): Account {
  if (!a || typeof a !== 'object') throw new Error('cone-config: account not an object');
  const acc = a as Record<string, unknown>;
  if (!isStr(acc.providerId)) throw new Error('cone-config: account.providerId required');
  if (!isStr(acc.kind)) throw new Error('cone-config: account.kind required');
  if (acc.kind === 'oauth') {
    if (!isStr(acc.accessToken)) throw new Error('cone-config: oauth account requires accessToken');
    return {
      providerId: acc.providerId,
      kind: 'oauth',
      accessToken: acc.accessToken,
      ...(isStr(acc.refreshToken) ? { refreshToken: acc.refreshToken } : {}),
      ...(typeof acc.tokenExpiresAt === 'number' ? { tokenExpiresAt: acc.tokenExpiresAt } : {}),
      ...(isStr(acc.userName) ? { userName: acc.userName } : {}),
      ...(isStr(acc.baseUrl) ? { baseUrl: acc.baseUrl } : {}),
    };
  }
  if (acc.kind === 'apikey') {
    if (!isStr(acc.apiKey)) throw new Error('cone-config: apikey account requires apiKey');
    return {
      providerId: acc.providerId,
      kind: 'apikey',
      apiKey: acc.apiKey,
      ...(isStr(acc.baseUrl) ? { baseUrl: acc.baseUrl } : {}),
      ...(isStr(acc.deployment) ? { deployment: acc.deployment } : {}),
      ...(isStr(acc.apiVersion) ? { apiVersion: acc.apiVersion } : {}),
    };
  }
  throw new Error(`cone-config: account.kind must be 'oauth' | 'apikey'`);
}

// secrets.env is line-based (NAME=value / NAME_DOMAINS=a,b) with no escaping,
// so a newline/CR in a name or value would inject phantom lines on round-trip.
// Names must be env-var identifiers; values and domains must be single-line.
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
function hasNewline(v: string): boolean {
  return /[\r\n]/.test(v);
}

function validateSecret(s: unknown): SecretEntry {
  if (!s || typeof s !== 'object') throw new Error('cone-config: secret not an object');
  const sec = s as Record<string, unknown>;
  if (!isStr(sec.name)) throw new Error('cone-config: secret.name required');
  if (!ENV_NAME_RE.test(sec.name)) {
    throw new Error(
      'cone-config: secret.name must be an env-var identifier ([A-Za-z_][A-Za-z0-9_]*)'
    );
  }
  if (!isStr(sec.value)) throw new Error('cone-config: secret.value required');
  if (hasNewline(sec.value)) throw new Error('cone-config: secret.value must be single-line');
  if (!Array.isArray(sec.domains) || !sec.domains.every(isStr)) {
    throw new Error('cone-config: secret.domains must be string[]');
  }
  if ((sec.domains as string[]).some((d) => hasNewline(d) || d.includes(','))) {
    throw new Error('cone-config: secret.domains entries must be single-line and comma-free');
  }
  return { name: sec.name, value: sec.value, domains: sec.domains as string[] };
}

export function mergeConeConfig(base: ConeConfig, delta: ConeConfigDelta): ConeConfig {
  const accounts = new Map(base.accounts.map((a) => [a.providerId, a]));
  for (const a of delta.upsert?.accounts ?? []) accounts.set(a.providerId, a);
  for (const id of delta.delete?.providerIds ?? []) accounts.delete(id);
  const secrets = new Map(base.secrets.map((s) => [s.name, s]));
  for (const s of delta.upsert?.secrets ?? []) secrets.set(s.name, s);
  for (const n of delta.delete?.secretNames ?? []) secrets.delete(n);
  return {
    model: delta.model ?? base.model,
    accounts: [...accounts.values()],
    secrets: [...secrets.values()],
  };
}

/**
 * Serialize flat secrets to the `NAME=value` / `NAME_DOMAINS=a,b` line format
 * that node-server's EnvSecretStore reads. Values are written verbatim (no
 * escaping — matching the existing parser), so secret names must be env-var
 * identifiers and values/domains must be single-line (no newlines, and values
 * must not break `NAME=value` parsing). Callers sanitize/validate inputs.
 */
export function serializeSecretsEnv(secrets: SecretEntry[]): string {
  const lines: string[] = [];
  for (const s of secrets) {
    lines.push(`${s.name}=${s.value}`);
    lines.push(`${s.name}_DOMAINS=${s.domains.join(',')}`);
  }
  return lines.length ? lines.join('\n') + '\n' : '';
}

export function bundleToFiles(cfg: ConeConfig): { coneConfigJson: string; secretsEnv: string } {
  return {
    // Secrets are excluded here and serialized separately into secretsEnv.
    coneConfigJson: JSON.stringify({ model: cfg.model, accounts: cfg.accounts }),
    secretsEnv: serializeSecretsEnv(cfg.secrets),
  };
}

export function bundleIndex(cfg: ConeConfig): ConeConfigIndex {
  return {
    model: cfg.model,
    accountProviderIds: cfg.accounts.map((a) => a.providerId),
    accountMeta: cfg.accounts.map((a) => ({
      providerId: a.providerId,
      kind: a.kind,
      tokenExpiresAt: a.kind === 'oauth' ? a.tokenExpiresAt : undefined,
    })),
    secretNames: cfg.secrets.map((s) => s.name),
  };
}

/** Portable base64 of a UTF-8 string (worker/browser/node all have btoa+TextEncoder). */
export function encodeBundleEnv(json: string): string {
  const bytes = new TextEncoder().encode(json);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
export function decodeBundleEnv(b64: string): string {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
