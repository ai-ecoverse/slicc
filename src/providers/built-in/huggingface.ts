import type { ProviderConfig } from '../types.js';

export const config: ProviderConfig = {
  id: 'huggingface',
  name: 'HuggingFace',
  description: 'Inference API models',
  requiresApiKey: true,
  apiKeyPlaceholder: 'hf_...',
  apiKeyEnvVar: 'HF_TOKEN',
  requiresBaseUrl: false,
};
