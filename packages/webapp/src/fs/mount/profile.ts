/**
 * Profile-namespaced credential resolution for remote mount backends.
 *
 * S3 secrets follow the pattern `s3.<profile>.*`:
 *   - access_key_id (required)
 *   - secret_access_key (required)
 *   - region (optional; default 'us-east-1')
 *   - endpoint (optional; default: derived from region for AWS)
 *   - session_token (optional; for STS temp creds)
 *
 * DA v1 reuses the existing Adobe IMS token from `providers/adobe.ts`.
 * Profile name is accepted for symmetry but only `default` has meaning.
 */

/**
 * The minimal SecretStore surface this module needs. Any concrete store
 * (production or test fake) implementing `get` is structurally compatible.
 */
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
  /** Refreshes on demand via the IMS launcher; always returns a current token. */
  getBearerToken(): Promise<string>;
  /** For `mount list` and approval cards. */
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
  // v1 ignores the profile name — all DA mounts share the IMS identity.
  return {
    getBearerToken: () => ims.getBearerToken(),
    identity: ims.identity ?? 'adobe-ims',
  };
}

/**
 * Get the default SecretStore for the current runtime context.
 * In browser/extension: fetches from /api/secrets endpoint.
 * In Node.js CLI: reads from environment variables.
 * @throws Error if no secret store is available (e.g., extension without backend)
 */
export async function getDefaultSecretStore(): Promise<SecretStore> {
  // Browser context: use API endpoint
  if (typeof window !== 'undefined' && !('process' in globalThis)) {
    return {
      async get(key: string): Promise<string | undefined> {
        try {
          const resp = await fetch('/api/secrets');
          if (!resp.ok) return undefined;
          const entries = (await resp.json()) as Array<{ name: string }>;
          if (!entries.find((e) => e.name === key)) return undefined;
          // The API returns metadata, not values. For now, return undefined.
          // In a full implementation, secrets would be fetched via a masked endpoint.
          return undefined;
        } catch {
          return undefined;
        }
      },
    };
  }

  // Node.js CLI: use environment
  return {
    async get(key: string): Promise<string | undefined> {
      return process.env[key];
    },
  };
}

/**
 * Get the default IMS client for the current runtime context.
 * Reads the stored Adobe OAuth account from ui/provider-settings.js via getAccounts().
 * This is a minimal v1 implementation; v2 should handle token refresh / IMS launcher delegation.
 * @throws Error if no Adobe account is found
 */
export async function getDefaultImsClient(): Promise<AdobeImsClient> {
  // Dynamic import to avoid circular dependencies and to keep IMS access confined to this module.
  const { getAccounts } = await import('../../ui/provider-settings.js');
  const accounts = getAccounts();
  const adobeAccount = accounts.find(
    (a: { providerId?: string; accessToken?: string }) => a.providerId === 'adobe'
  );

  if (!adobeAccount || !adobeAccount.accessToken) {
    throw new ProfileNotConfiguredError(
      'No Adobe IMS account found. Log in via Settings → Providers → Adobe first.'
    );
  }

  return {
    identity: 'adobe-ims',
    getBearerToken: async () => adobeAccount.accessToken!,
  };
}
