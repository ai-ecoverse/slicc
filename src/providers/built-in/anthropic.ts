import type { ProviderConfig } from '../types.js';

export const config: ProviderConfig = {
  id: 'anthropic',
  name: 'Anthropic',
  description: 'Claude models via Anthropic API',
  requiresApiKey: true,
  apiKeyPlaceholder: 'sk-ant-...',
  apiKeyEnvVar: 'ANTHROPIC_API_KEY',
  requiresBaseUrl: false,
};
