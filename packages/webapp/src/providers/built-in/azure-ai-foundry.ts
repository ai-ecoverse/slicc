/**
 * Azure AI Foundry — Claude models via Azure's Anthropic endpoint.
 *
 * This is a slicc-specific routing provider (not a pi-ai provider).
 * It uses Anthropic's model registry and stream functions but routes
 * through a custom Azure base URL. No register() needed — the model
 * resolution in provider-settings.ts handles the routing.
 */

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
