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
  effortLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  accounts: Account[];
  secrets: SecretEntry[];
}

export interface ConeConfigDelta {
  model?: string;
  effortLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | null;
  upsert?: { accounts?: Account[]; secrets?: SecretEntry[] };
  delete?: { providerIds?: string[]; secretNames?: string[] };
}

export interface ConeConfigIndex {
  model: string;
  effortLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  accountProviderIds: string[];
  accountMeta: Array<{ providerId: string; kind: Account['kind']; tokenExpiresAt?: number }>;
  secretNames: string[];
}

/** Max serialized bundle size (bytes) accepted as a preboot env payload. */
export const MAX_CONE_CONFIG_BYTES = 256 * 1024;

function isStr(v: unknown): v is string {
  return typeof v === 'string';
}

const VALID_EFFORT_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);

export function validateConeConfig(input: unknown): ConeConfig {
  if (!input || typeof input !== 'object') throw new Error('cone-config: not an object');
  const cfg = input as Record<string, unknown>;
  if (!isStr(cfg.model)) throw new Error('cone-config: model must be a string');
  if (!Array.isArray(cfg.accounts)) throw new Error('cone-config: accounts must be an array');
  if (!Array.isArray(cfg.secrets)) throw new Error('cone-config: secrets must be an array');
  const accounts = cfg.accounts.map((a) => validateAccount(a));
  const secrets = cfg.secrets.map((s) => validateSecret(s));
  const result: ConeConfig = { model: cfg.model, accounts, secrets };
  if (cfg.effortLevel !== undefined) {
    if (!isStr(cfg.effortLevel) || !VALID_EFFORT_LEVELS.has(cfg.effortLevel)) {
      throw new Error('cone-config: effortLevel must be one of off|minimal|low|medium|high|xhigh');
    }
    result.effortLevel = cfg.effortLevel as ConeConfig['effortLevel'];
  }
  return result;
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

/** Validate the `upsert` arm of a resume delta (accounts/secrets reuse the full-bundle validators). */
function validateDeltaUpsert(input: unknown): { accounts?: Account[]; secrets?: SecretEntry[] } {
  if (!input || typeof input !== 'object') {
    throw new Error('cone-config: delta.upsert must be an object');
  }
  const up = input as Record<string, unknown>;
  const upsert: { accounts?: Account[]; secrets?: SecretEntry[] } = {};
  if (up.accounts !== undefined) {
    if (!Array.isArray(up.accounts)) {
      throw new Error('cone-config: delta.upsert.accounts must be an array');
    }
    upsert.accounts = up.accounts.map((a) => validateAccount(a));
  }
  if (up.secrets !== undefined) {
    if (!Array.isArray(up.secrets)) {
      throw new Error('cone-config: delta.upsert.secrets must be an array');
    }
    upsert.secrets = up.secrets.map((s) => validateSecret(s));
  }
  return upsert;
}

/** Validate the `delete` arm of a resume delta (provider-id / secret-name string lists). */
function validateDeltaDelete(input: unknown): { providerIds?: string[]; secretNames?: string[] } {
  if (!input || typeof input !== 'object') {
    throw new Error('cone-config: delta.delete must be an object');
  }
  const del = input as Record<string, unknown>;
  const deletion: { providerIds?: string[]; secretNames?: string[] } = {};
  if (del.providerIds !== undefined) {
    if (!Array.isArray(del.providerIds) || !del.providerIds.every(isStr)) {
      throw new Error('cone-config: delta.delete.providerIds must be string[]');
    }
    deletion.providerIds = del.providerIds as string[];
  }
  if (del.secretNames !== undefined) {
    if (!Array.isArray(del.secretNames) || !del.secretNames.every(isStr)) {
      throw new Error('cone-config: delta.delete.secretNames must be string[]');
    }
    deletion.secretNames = del.secretNames as string[];
  }
  return deletion;
}

/**
 * Validate an untrusted resume delta (the worker receives it as `unknown`).
 * Nested accounts/secrets go through the same validators as a full bundle, so a
 * malformed or newline-injecting entry is rejected at the boundary with a clear
 * message rather than blowing up later inside mergeConeConfig.
 */
export function validateConeConfigDelta(input: unknown): ConeConfigDelta {
  if (!input || typeof input !== 'object') throw new Error('cone-config: delta not an object');
  const d = input as Record<string, unknown>;
  const out: ConeConfigDelta = {};
  if (d.model !== undefined) {
    if (!isStr(d.model)) throw new Error('cone-config: delta.model must be a string');
    out.model = d.model;
  }
  if (d.effortLevel !== undefined) {
    if (d.effortLevel === null) {
      out.effortLevel = null;
    } else if (!isStr(d.effortLevel) || !VALID_EFFORT_LEVELS.has(d.effortLevel)) {
      throw new Error(
        'cone-config: delta.effortLevel must be one of off|minimal|low|medium|high|xhigh or null'
      );
    } else {
      out.effortLevel = d.effortLevel as ConeConfig['effortLevel'];
    }
  }
  if (d.upsert !== undefined) out.upsert = validateDeltaUpsert(d.upsert);
  if (d.delete !== undefined) out.delete = validateDeltaDelete(d.delete);
  return out;
}

export function mergeConeConfig(base: ConeConfig, delta: ConeConfigDelta): ConeConfig {
  const accounts = new Map(base.accounts.map((a) => [a.providerId, a]));
  for (const a of delta.upsert?.accounts ?? []) accounts.set(a.providerId, a);
  for (const id of delta.delete?.providerIds ?? []) accounts.delete(id);
  const secrets = new Map(base.secrets.map((s) => [s.name, s]));
  for (const s of delta.upsert?.secrets ?? []) secrets.set(s.name, s);
  for (const n of delta.delete?.secretNames ?? []) secrets.delete(n);
  const result: ConeConfig = {
    model: delta.model ?? base.model,
    accounts: [...accounts.values()],
    secrets: [...secrets.values()],
  };
  if (delta.effortLevel !== undefined) {
    result.effortLevel = delta.effortLevel === null ? undefined : delta.effortLevel;
  } else if (base.effortLevel) {
    result.effortLevel = base.effortLevel;
  }
  return result;
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
    coneConfigJson: JSON.stringify({
      model: cfg.model,
      ...(cfg.effortLevel ? { effortLevel: cfg.effortLevel } : {}),
      accounts: cfg.accounts,
    }),
    secretsEnv: serializeSecretsEnv(cfg.secrets),
  };
}

export function bundleIndex(cfg: ConeConfig): ConeConfigIndex {
  return {
    model: cfg.model,
    ...(cfg.effortLevel ? { effortLevel: cfg.effortLevel } : {}),
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

/** Decode a base64url segment (JWT alphabet) to a UTF-8 string. */
function decodeBase64Url(seg: string): string {
  // base64url → base64; atob (forgiving-base64) tolerates the missing padding.
  const b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * Best-effort expiry (epoch ms) of an Adobe IMS access token, for stamping
 * onto a synthesized Adobe `OAuthAccount.tokenExpiresAt`.
 *
 * Why it matters: a window-less kernel-worker cone must not treat a still-valid
 * token as expired. The webapp's `getValidAccessToken` (providers/adobe.ts)
 * returns the token only while `tokenExpiresAt` is in the future; otherwise it
 * attempts a silent renewal that ALWAYS returns null in a worker (no `window`)
 * and then throws "Adobe session expired". Without an expiry the account
 * defaults to `tokenExpiresAt ?? 0`, so the very first turn fails. Every site
 * that synthesizes an Adobe oauth account from a bare IMS bearer — node-server's
 * legacy-token branch and the worker's back-compat + resume paths — must stamp
 * this or reintroduce that failure mode.
 *
 * IMS access tokens are JWTs whose payload carries `created_at` + `expires_in`
 * (both epoch ms). Returns `created_at + expires_in`, or `undefined` for opaque
 * / unparseable tokens (callers then leave `tokenExpiresAt` unset — prior
 * behavior). Side-effect- and dependency-free (`atob`, not `node:Buffer`) so it
 * is safe to call from the CF Worker and the browser as well as node-server.
 */
export function imsTokenExpiry(token: string): number | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(decodeBase64Url(parts[1]!)) as {
      created_at?: unknown;
      expires_in?: unknown;
    };
    const created = Number(payload.created_at);
    const ttl = Number(payload.expires_in);
    if (Number.isFinite(created) && created > 0 && Number.isFinite(ttl) && ttl > 0) {
      return created + ttl;
    }
  } catch {
    // opaque / malformed token — leave expiry unset
  }
  return undefined;
}
