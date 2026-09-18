import {
  bundleToFiles,
  type ConeConfig,
  DEFAULT_CONE_MODEL,
  imsTokenExpiry,
  validateConeConfig,
} from '@slicc/cloud-core/cone-config';

export const ADOBE_TOKEN_DOMAINS = 'adobe-llm-proxy.paolo-moz.workers.dev';

const AUTH_OPTIONAL_PROVIDERS = new Set<string>(['local']);

export function assertModelHasAccount(bundle: ConeConfig): void {
  const provider = bundle.model.split(':')[0];
  if (AUTH_OPTIONAL_PROVIDERS.has(provider)) return;
  if (!bundle.accounts.some((a) => a.providerId === provider)) {
    throw new Error(`model provider '${provider}' has no account in the bundle`);
  }
}

export function coneConfigToBundle(input: unknown, bearer: string): ConeConfig {
  if (input === undefined || input === null) {
    const expiresAt = imsTokenExpiry(bearer);
    return {
      model: DEFAULT_CONE_MODEL,
      accounts: [
        {
          providerId: 'adobe',
          kind: 'oauth',
          accessToken: bearer,
          ...(expiresAt !== undefined ? { tokenExpiresAt: expiresAt } : {}),
        },
      ],

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
