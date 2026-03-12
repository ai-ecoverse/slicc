import type { ProviderConfig } from '../types.js';

export const config: ProviderConfig = {
  id: 'amazon-bedrock',
  name: 'AWS Bedrock',
  description: 'Claude, Llama, and more on AWS',
  requiresApiKey: true,
  apiKeyPlaceholder: 'Session token or credentials',
  apiKeyEnvVar: 'AWS_SESSION_TOKEN',
  requiresBaseUrl: true,
  baseUrlPlaceholder: 'https://bedrock-runtime.us-east-1.amazonaws.com',
  baseUrlDescription: 'Bedrock runtime endpoint (region-specific)',
};
