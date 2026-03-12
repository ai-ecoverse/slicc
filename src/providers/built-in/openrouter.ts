import type { ProviderConfig } from '../types.js';

export const config: ProviderConfig = {
  id: 'openrouter',
  name: 'OpenRouter',
  description: '200+ models from multiple providers',
  requiresApiKey: true,
  apiKeyPlaceholder: 'sk-or-...',
  apiKeyEnvVar: 'OPENROUTER_API_KEY',
  requiresBaseUrl: false,
};
