export { domainMatches as matchDomain, matchesDomains } from '@slicc/shared-ts';
export { parseEnvFile, serializeEnvFile } from './env-file.js';
export { EnvSecretStore } from './env-secret-store.js';
export { SecretProxyManager } from './proxy-manager.js';
export type { MaskedSecret, Secret, SecretEntry, SecretStore } from './types.js';
