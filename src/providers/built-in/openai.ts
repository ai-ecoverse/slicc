import type { ProviderConfig } from '../types.js';

export const config: ProviderConfig = {
  id: 'openai',
  name: 'OpenAI',
  description: 'GPT and Codex models',
  requiresApiKey: true,
  apiKeyPlaceholder: 'sk-...',
  apiKeyEnvVar: 'OPENAI_API_KEY',
  requiresBaseUrl: false,
};
