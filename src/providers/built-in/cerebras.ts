import type { ProviderConfig } from '../types.js';

export const config: ProviderConfig = {
  id: 'cerebras',
  name: 'Cerebras',
  description: 'Fast inference on Cerebras hardware',
  requiresApiKey: true,
  apiKeyPlaceholder: 'Cerebras API key',
  apiKeyEnvVar: 'CEREBRAS_API_KEY',
  requiresBaseUrl: false,
};
