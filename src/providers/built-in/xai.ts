import type { ProviderConfig } from '../types.js';

export const config: ProviderConfig = {
  id: 'xai',
  name: 'xAI',
  description: 'Grok models',
  requiresApiKey: true,
  apiKeyPlaceholder: 'xAI API key',
  apiKeyEnvVar: 'XAI_API_KEY',
  requiresBaseUrl: false,
};
