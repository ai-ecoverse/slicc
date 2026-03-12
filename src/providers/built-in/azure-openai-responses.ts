import type { ProviderConfig } from '../types.js';

export const config: ProviderConfig = {
  id: 'azure-openai-responses',
  name: 'Azure (OpenAI/GPT)',
  description: 'GPT and Codex models on Azure OpenAI',
  requiresApiKey: true,
  apiKeyPlaceholder: 'Azure API key',
  apiKeyEnvVar: 'AZURE_OPENAI_API_KEY',
  requiresBaseUrl: true,
  baseUrlPlaceholder: 'https://your-resource.openai.azure.com',
  baseUrlDescription: 'Azure OpenAI endpoint URL',
};
