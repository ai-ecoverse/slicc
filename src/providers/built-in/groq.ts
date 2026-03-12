import type { ProviderConfig } from '../types.js';

export const config: ProviderConfig = {
  id: 'groq',
  name: 'Groq',
  description: 'Fast inference for open models',
  requiresApiKey: true,
  apiKeyPlaceholder: 'gsk_...',
  apiKeyEnvVar: 'GROQ_API_KEY',
  requiresBaseUrl: false,
};
