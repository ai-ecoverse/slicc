import type { ProviderConfig } from '../types.js';

export const config: ProviderConfig = {
  id: 'mistral',
  name: 'Mistral',
  description: 'Mistral AI models',
  requiresApiKey: true,
  apiKeyPlaceholder: 'Mistral API key',
  apiKeyEnvVar: 'MISTRAL_API_KEY',
  requiresBaseUrl: false,
};
