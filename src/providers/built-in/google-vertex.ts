import type { ProviderConfig } from '../types.js';

export const config: ProviderConfig = {
  id: 'google-vertex',
  name: 'Google Vertex AI',
  description: 'Gemini and Claude on Vertex',
  requiresApiKey: true,
  apiKeyPlaceholder: 'Access token',
  apiKeyEnvVar: 'GOOGLE_APPLICATION_CREDENTIALS',
  requiresBaseUrl: true,
  baseUrlPlaceholder: 'https://us-central1-aiplatform.googleapis.com',
  baseUrlDescription: 'Vertex AI endpoint URL',
};
