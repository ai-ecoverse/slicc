export type { Secret, SecretEntry, SecretStore, MaskedSecret } from './types.js';
export { EnvSecretStore } from './env-secret-store.js';
export { domainMatches as matchDomain, matchesDomains } from '@slicc/shared-ts';
export { parseEnvFile, serializeEnvFile } from './env-file.js';
export { SecretProxyManager } from './proxy-manager.js';
