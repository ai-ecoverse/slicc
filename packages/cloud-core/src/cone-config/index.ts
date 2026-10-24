import {
  isEffortLevel,
  serializeSecretsEnv as serializeSecretLines,
  validateAccount,
  validateSecret,
} from './cone-config-rules.mjs';

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

export const MAX_CONE_CONFIG_BYTES = 256 * 1024;

export const DEFAULT_CONE_MODEL = 'adobe:claude-opus-4-6';

interface UntrustedConeConfig {
  readonly model?: unknown;
  readonly effortLevel?: unknown;
  readonly accounts?: unknown;
  readonly secrets?: unknown;
}

interface UntrustedConeConfigDeltaUpsert {
  readonly accounts?: unknown;
  readonly secrets?: unknown;
}

interface UntrustedConeConfigDeltaDelete {
  readonly providerIds?: unknown;
  readonly secretNames?: unknown;
}

interface UntrustedConeConfigDelta {
  readonly model?: unknown;
  readonly effortLevel?: unknown;
  readonly upsert?: unknown;
  readonly delete?: unknown;
}

interface UntrustedImsTokenPayload {
  readonly created_at?: unknown;
  readonly expires_in?: unknown;
}

function isUntrustedObject(value: unknown): value is object {
  return value != null && typeof value === 'object';
}

function isStr(v: unknown): v is string {
  return typeof v === 'string';
}

export function validateConeConfig(input: unknown): ConeConfig {
  if (!isUntrustedObject(input)) throw new Error('cone-config: not an object');
  const cfg = input as UntrustedConeConfig;
  if (!isStr(cfg.model)) throw new Error('cone-config: model must be a string');
  if (!Array.isArray(cfg.accounts)) throw new Error('cone-config: accounts must be an array');
  if (!Array.isArray(cfg.secrets)) throw new Error('cone-config: secrets must be an array');
  const accounts = cfg.accounts.map((a, i) => validateAccount(a, `cone-config: accounts[${i}]`));
  const secrets = cfg.secrets.map((s, i) => validateSecret(s, `cone-config: secrets[${i}]`));
  const result: ConeConfig = { model: cfg.model, accounts, secrets };
  if (cfg.effortLevel !== undefined) {
    if (!isEffortLevel(cfg.effortLevel)) {
      throw new Error('cone-config: effortLevel must be one of off|minimal|low|medium|high|xhigh');
    }
    result.effortLevel = cfg.effortLevel;
  }
  return result;
}

function validateDeltaUpsert(input: unknown): { accounts?: Account[]; secrets?: SecretEntry[] } {
  if (!isUntrustedObject(input)) {
    throw new Error('cone-config: delta.upsert must be an object');
  }
  const up = input as UntrustedConeConfigDeltaUpsert;
  const upsert: { accounts?: Account[]; secrets?: SecretEntry[] } = {};
  if (up.accounts !== undefined) {
    if (!Array.isArray(up.accounts)) {
      throw new Error('cone-config: delta.upsert.accounts must be an array');
    }
    upsert.accounts = up.accounts.map((a, i) =>
      validateAccount(a, `cone-config: delta.upsert.accounts[${i}]`)
    );
  }
  if (up.secrets !== undefined) {
    if (!Array.isArray(up.secrets)) {
      throw new Error('cone-config: delta.upsert.secrets must be an array');
    }
    upsert.secrets = up.secrets.map((s, i) =>
      validateSecret(s, `cone-config: delta.upsert.secrets[${i}]`)
    );
  }
  return upsert;
}

function validateDeltaDelete(input: unknown): { providerIds?: string[]; secretNames?: string[] } {
  if (!isUntrustedObject(input)) {
    throw new Error('cone-config: delta.delete must be an object');
  }
  const del = input as UntrustedConeConfigDeltaDelete;
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

export function validateConeConfigDelta(input: unknown): ConeConfigDelta {
  if (!isUntrustedObject(input)) throw new Error('cone-config: delta not an object');
  const d = input as UntrustedConeConfigDelta;
  const out: ConeConfigDelta = {};
  if (d.model !== undefined) {
    if (!isStr(d.model)) throw new Error('cone-config: delta.model must be a string');
    out.model = d.model;
  }
  if (d.effortLevel !== undefined) {
    if (d.effortLevel === null) {
      out.effortLevel = null;
    } else if (!isEffortLevel(d.effortLevel)) {
      throw new Error(
        'cone-config: delta.effortLevel must be one of off|minimal|low|medium|high|xhigh or null'
      );
    } else {
      out.effortLevel = d.effortLevel;
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

export function serializeSecretsEnv(secrets: SecretEntry[]): string {
  return serializeSecretLines(secrets);
}

export function bundleToFiles(cfg: ConeConfig): { coneConfigJson: string; secretsEnv: string } {
  return {
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

function decodeBase64Url(seg: string): string {
  const b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function imsTokenExpiry(token: string): number | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(decodeBase64Url(parts[1]!)) as UntrustedImsTokenPayload;
    const created = Number(payload.created_at);
    const ttl = Number(payload.expires_in);
    if (Number.isFinite(created) && created > 0 && Number.isFinite(ttl) && ttl > 0) {
      return created + ttl;
    }
  } catch {}
  return undefined;
}
