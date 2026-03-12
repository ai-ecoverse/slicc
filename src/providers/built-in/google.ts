import type { ProviderConfig } from '../types.js';

export const config: ProviderConfig = {
  id: 'google',
  name: 'Google AI',
  description: 'Gemini models via Google AI Studio',
  requiresApiKey: true,
  apiKeyPlaceholder: 'AI...',
  apiKeyEnvVar: 'GOOGLE_API_KEY',
  requiresBaseUrl: false,
};
