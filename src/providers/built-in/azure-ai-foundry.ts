import type { ProviderConfig } from '../types.js';

export const config: ProviderConfig = {
  id: 'azure-ai-foundry',
  name: 'Azure (Claude)',
  description: 'Claude models via Azure AI Foundry',
  requiresApiKey: true,
  apiKeyPlaceholder: 'Azure API key',
  apiKeyEnvVar: 'AZURE_API_KEY',
  requiresBaseUrl: true,
  baseUrlPlaceholder: 'https://your-resource.services.ai.azure.com/anthropic',
  baseUrlDescription: 'Azure AI Foundry endpoint — must end with /anthropic',
};
