import {
  bundleToFiles,
  type ConeConfig,
  imsTokenExpiry,
  validateConeConfig,
} from '@slicc/cloud-core/cone-config';

// Import the existing ADOBE_TOKEN_DOMAINS constant (will export it from cloud-sessions-do)
import { ADOBE_TOKEN_DOMAINS } from './cloud-sessions-do.js';

const DEFAULT_MODEL = 'adobe:claude-opus-4-6';
const AUTH_OPTIONAL_PROVIDERS = new Set<string>(['local']);

/** Narrow F6 re-validation: the model's provider must have an account (unless auth-optional). */
export function assertModelHasAccount(bundle: ConeConfig): void {
  const provider = bundle.model.split(':')[0];
  if (AUTH_OPTIONAL_PROVIDERS.has(provider)) return;
  if (!bundle.accounts.some((a) => a.providerId === provider)) {
    throw new Error(`model provider '${provider}' has no account in the bundle`);
  }
}

/** Validate a client bundle, or synthesize the Adobe default from the cloud bearer. */
export function coneConfigToBundle(input: unknown, bearer: string): ConeConfig {
  if (input === undefined || input === null) {
    // Stamp tokenExpiresAt so the window-less kernel-worker cone doesn't treat a
    // still-valid IMS token as expired and throw "Adobe session expired" on its
    // first turn (the cone-config branch this synthesizes hits the same
    // window-less getValidAccessToken path as node-server's legacy branch).
    const expiresAt = imsTokenExpiry(bearer);
    return {
      model: DEFAULT_MODEL,
      accounts: [
        {
          providerId: 'adobe',
          kind: 'oauth',
          accessToken: bearer,
          ...(expiresAt !== undefined ? { tokenExpiresAt: expiresAt } : {}),
        },
      ],
      // One entry only: serializeSecretsEnv auto-emits the `ADOBE_IMS_TOKEN_DOMAINS`
      // line from this secret's `domains`. Listing `_DOMAINS` as its own secret would
      // produce a duplicate line plus a bogus `ADOBE_IMS_TOKEN_DOMAINS_DOMAINS`.
      secrets: [{ name: 'ADOBE_IMS_TOKEN', value: bearer, domains: [ADOBE_TOKEN_DOMAINS] }],
    };
  }
  const bundle = validateConeConfig(input);
  assertModelHasAccount(bundle);
  return bundle;
}

export function buildStartConeArgs(
  bundle: ConeConfig,
  _bearer: string
): { envContents: string; coneConfigJson: string } {
  const { coneConfigJson, secretsEnv } = bundleToFiles(bundle);
  return { envContents: secretsEnv, coneConfigJson };
}
