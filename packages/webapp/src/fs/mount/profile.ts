import { apiHeaders, resolveApiUrl } from '../../base/api-endpoint.js';

export interface SecretStore {
  get(key: string): Promise<string | undefined>;
}

export interface S3Profile {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
  endpoint?: string;
}

export interface DaProfile {
  getBearerToken(): Promise<string>;

  identity: string;
}

export interface AdobeImsClient {
  getBearerToken(): Promise<string>;
  identity?: string;
}

export class ProfileNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileNotConfiguredError';
  }
}

export async function resolveS3Profile(name: string, store: SecretStore): Promise<S3Profile> {
  const prefix = `s3.${name}.`;
  const accessKeyId = await store.get(`${prefix}access_key_id`);
  const secretAccessKey = await store.get(`${prefix}secret_access_key`);

  if (!accessKeyId) {
    throw new ProfileNotConfiguredError(
      `profile '${name}' missing required field 'access_key_id'. ` +
        `Set it via: secret set ${prefix}access_key_id <value>`
    );
  }
  if (!secretAccessKey) {
    throw new ProfileNotConfiguredError(
      `profile '${name}' missing required field 'secret_access_key'. ` +
        `Set it via: secret set ${prefix}secret_access_key <value>`
    );
  }

  return {
    accessKeyId,
    secretAccessKey,
    sessionToken: await store.get(`${prefix}session_token`),
    region: (await store.get(`${prefix}region`)) ?? 'us-east-1',
    endpoint: await store.get(`${prefix}endpoint`),
  };
}

export async function resolveDaProfile(_name: string, ims: AdobeImsClient): Promise<DaProfile> {
  return {
    getBearerToken: () => ims.getBearerToken(),
    identity: ims.identity ?? 'adobe-ims',
  };
}

export async function getDefaultSecretStore(): Promise<SecretStore> {
  if (typeof window !== 'undefined' && !('process' in globalThis)) {
    return {
      async get(key: string): Promise<string | undefined> {
        try {
          const resp = await fetch(resolveApiUrl('/api/secrets'), { headers: apiHeaders() });
          if (!resp.ok) return undefined;
          const entries = (await resp.json()) as Array<{ name: string }>;
          if (!entries.find((e) => e.name === key)) return undefined;

          return undefined;
        } catch {
          return undefined;
        }
      },
    };
  }

  return {
    async get(key: string): Promise<string | undefined> {
      return process.env[key];
    },
  };
}

export async function getDefaultImsClient(): Promise<AdobeImsClient> {
  const { getAccounts } = await import('../../providers/account-store.js');
  const accounts = getAccounts();
  const adobeAccount = accounts.find(
    (a: { providerId?: string; accessToken?: string }) => a.providerId === 'adobe'
  );

  if (!adobeAccount?.accessToken) {
    throw new ProfileNotConfiguredError(
      'No Adobe IMS account found. Log in via Settings → Providers → Adobe first.'
    );
  }

  return {
    identity: 'adobe-ims',
    getBearerToken: async () => adobeAccount.accessToken!,
  };
}
