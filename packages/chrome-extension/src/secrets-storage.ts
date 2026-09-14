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

export type SecretsStorageItems = { [key: string]: unknown };

export interface StorageArea {
  get(keys?: null | string | string[]): Promise<SecretsStorageItems>;
  set(items: SecretsStorageItems): Promise<void>;
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

export async function listSecretsWithValues(storage: StorageArea): Promise<SecretEntryWithValue[]> {
  const all = await storage.get(null);
  return pairStorageEntries(all);
}

function pairStorageEntries(all: SecretsStorageItems): SecretEntryWithValue[] {
  return pairEnvEntriesToSecrets(
    Object.entries(all).flatMap(([key, value]) =>
      typeof value === 'string' ? [{ key, value }] : []
    )
  );
}
