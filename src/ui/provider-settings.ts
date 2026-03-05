/**
 * Provider Settings — unified configuration for all pi-ai providers.
 * Replaces the old API Key dialog with a comprehensive provider selector,
 * provider-specific options, and dynamic model population.
 */

import { getProviders, getModels, getModel } from '../core/index.js';
import type { Model } from '../core/index.js';

// Storage keys
const STORAGE_KEYS = {
  provider: 'slicc_provider',
  apiKey: 'slicc_api_key',
  baseUrl: 'slicc_base_url',
  model: 'selected-model',
  // Legacy keys for migration
  legacyApiKey: 'anthropic_api_key',
  legacyProvider: 'api_provider',
  legacyAzureResource: 'azure_resource',
  legacyBedrockRegion: 'bedrock_region',
} as const;

// Provider metadata with display names and required fields
interface ProviderConfig {
  id: string;
  name: string;
  description: string;
  requiresApiKey: boolean;
  apiKeyPlaceholder?: string;
  apiKeyEnvVar?: string;
  requiresBaseUrl: boolean;
  baseUrlPlaceholder?: string;
  baseUrlDescription?: string;
}

const PROVIDER_CONFIGS: Record<string, ProviderConfig> = {
  'anthropic': {
    id: 'anthropic',
    name: 'Anthropic',
    description: 'Claude models via Anthropic API',
    requiresApiKey: true,
    apiKeyPlaceholder: 'sk-ant-...',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    requiresBaseUrl: false,
  },
  'openai': {
    id: 'openai',
    name: 'OpenAI',
    description: 'GPT and Codex models',
    requiresApiKey: true,
    apiKeyPlaceholder: 'sk-...',
    apiKeyEnvVar: 'OPENAI_API_KEY',
    requiresBaseUrl: false,
  },
  'openrouter': {
    id: 'openrouter',
    name: 'OpenRouter',
    description: '200+ models from multiple providers',
    requiresApiKey: true,
    apiKeyPlaceholder: 'sk-or-...',
    apiKeyEnvVar: 'OPENROUTER_API_KEY',
    requiresBaseUrl: false,
  },
  'groq': {
    id: 'groq',
    name: 'Groq',
    description: 'Fast inference for open models',
    requiresApiKey: true,
    apiKeyPlaceholder: 'gsk_...',
    apiKeyEnvVar: 'GROQ_API_KEY',
    requiresBaseUrl: false,
  },
  'google': {
    id: 'google',
    name: 'Google AI',
    description: 'Gemini models via Google AI Studio',
    requiresApiKey: true,
    apiKeyPlaceholder: 'AI...',
    apiKeyEnvVar: 'GOOGLE_API_KEY',
    requiresBaseUrl: false,
  },
  'google-vertex': {
    id: 'google-vertex',
    name: 'Google Vertex AI',
    description: 'Gemini and Claude on Vertex',
    requiresApiKey: true,
    apiKeyPlaceholder: 'Access token',
    apiKeyEnvVar: 'GOOGLE_APPLICATION_CREDENTIALS',
    requiresBaseUrl: true,
    baseUrlPlaceholder: 'https://us-central1-aiplatform.googleapis.com',
    baseUrlDescription: 'Vertex AI endpoint URL',
  },
  'amazon-bedrock': {
    id: 'amazon-bedrock',
    name: 'AWS Bedrock',
    description: 'Claude, Llama, and more on AWS',
    requiresApiKey: true,
    apiKeyPlaceholder: 'Session token or credentials',
    apiKeyEnvVar: 'AWS_SESSION_TOKEN',
    requiresBaseUrl: true,
    baseUrlPlaceholder: 'https://bedrock-runtime.us-east-1.amazonaws.com',
    baseUrlDescription: 'Bedrock runtime endpoint (region-specific)',
  },
  'azure-openai-responses': {
    id: 'azure-openai-responses',
    name: 'Azure OpenAI',
    description: 'OpenAI models on Azure',
    requiresApiKey: true,
    apiKeyPlaceholder: 'Azure API key',
    apiKeyEnvVar: 'AZURE_OPENAI_API_KEY',
    requiresBaseUrl: true,
    baseUrlPlaceholder: 'https://your-resource.openai.azure.com',
    baseUrlDescription: 'Azure OpenAI endpoint URL',
  },
  'mistral': {
    id: 'mistral',
    name: 'Mistral',
    description: 'Mistral AI models',
    requiresApiKey: true,
    apiKeyPlaceholder: 'Mistral API key',
    apiKeyEnvVar: 'MISTRAL_API_KEY',
    requiresBaseUrl: false,
  },
  'xai': {
    id: 'xai',
    name: 'xAI',
    description: 'Grok models',
    requiresApiKey: true,
    apiKeyPlaceholder: 'xAI API key',
    apiKeyEnvVar: 'XAI_API_KEY',
    requiresBaseUrl: false,
  },
  'cerebras': {
    id: 'cerebras',
    name: 'Cerebras',
    description: 'Fast inference on Cerebras hardware',
    requiresApiKey: true,
    apiKeyPlaceholder: 'Cerebras API key',
    apiKeyEnvVar: 'CEREBRAS_API_KEY',
    requiresBaseUrl: false,
  },
  'huggingface': {
    id: 'huggingface',
    name: 'HuggingFace',
    description: 'Inference API models',
    requiresApiKey: true,
    apiKeyPlaceholder: 'hf_...',
    apiKeyEnvVar: 'HF_TOKEN',
    requiresBaseUrl: false,
  },
};

// Get all available providers from pi-ai
export function getAvailableProviders(): string[] {
  return getProviders();
}

// Get provider config with fallback for unknown providers
export function getProviderConfig(providerId: string): ProviderConfig {
  return PROVIDER_CONFIGS[providerId] || {
    id: providerId,
    name: providerId.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
    description: `${providerId} provider`,
    requiresApiKey: true,
    requiresBaseUrl: false,
  };
}

// Get models for a provider
export function getProviderModels(providerId: string): Model<any>[] {
  try {
    return getModels(providerId as any);
  } catch {
    return [];
  }
}

// Storage functions
export function getSelectedProvider(): string {
  // Check for new storage first, then migrate from legacy
  const stored = localStorage.getItem(STORAGE_KEYS.provider);
  if (stored) return stored;
  
  // Migrate from legacy
  const legacy = localStorage.getItem(STORAGE_KEYS.legacyProvider);
  if (legacy) {
    // Map old provider names to new ones
    const mapping: Record<string, string> = {
      'anthropic': 'anthropic',
      'azure': 'azure-openai-responses',
      'bedrock': 'amazon-bedrock',
    };
    return mapping[legacy] || 'anthropic';
  }
  
  return 'anthropic';
}

export function setSelectedProvider(provider: string): void {
  localStorage.setItem(STORAGE_KEYS.provider, provider);
}

export function getApiKey(): string | null {
  // Check new storage first
  const stored = localStorage.getItem(STORAGE_KEYS.apiKey);
  if (stored) return stored;
  
  // Migrate from legacy
  return localStorage.getItem(STORAGE_KEYS.legacyApiKey);
}

export function setApiKey(key: string): void {
  localStorage.setItem(STORAGE_KEYS.apiKey, key);
}

export function clearApiKey(): void {
  localStorage.removeItem(STORAGE_KEYS.apiKey);
  localStorage.removeItem(STORAGE_KEYS.legacyApiKey);
}

export function getBaseUrl(): string | null {
  const stored = localStorage.getItem(STORAGE_KEYS.baseUrl);
  if (stored) return stored;
  
  // Migrate from legacy azure/bedrock
  const provider = getSelectedProvider();
  if (provider === 'azure-openai-responses') {
    const resource = localStorage.getItem(STORAGE_KEYS.legacyAzureResource);
    if (resource) {
      return resource.includes('://') ? resource : `https://${resource}.openai.azure.com`;
    }
  } else if (provider === 'amazon-bedrock') {
    return localStorage.getItem(STORAGE_KEYS.legacyBedrockRegion);
  }
  
  return null;
}

export function setBaseUrl(url: string): void {
  if (url) {
    localStorage.setItem(STORAGE_KEYS.baseUrl, url);
  } else {
    localStorage.removeItem(STORAGE_KEYS.baseUrl);
  }
}

export function clearBaseUrl(): void {
  localStorage.removeItem(STORAGE_KEYS.baseUrl);
}

export function getSelectedModelId(): string {
  return localStorage.getItem(STORAGE_KEYS.model) || '';
}

export function setSelectedModelId(modelId: string): void {
  localStorage.setItem(STORAGE_KEYS.model, modelId);
}

// Clear all provider settings
export function clearAllSettings(): void {
  Object.values(STORAGE_KEYS).forEach(key => localStorage.removeItem(key));
}

// Resolve the current model with provider-specific baseUrl override
export function resolveCurrentModel(): Model<any> {
  const providerId = getSelectedProvider();
  const modelId = getSelectedModelId();
  const baseUrl = getBaseUrl();
  
  // Get default model if none selected
  const models = getProviderModels(providerId);
  const effectiveModelId = modelId || models[0]?.id || 'claude-sonnet-4-20250514';
  
  try {
    let model = getModel(providerId as any, effectiveModelId as any);
    
    // Override baseUrl if custom one is set
    if (baseUrl) {
      model = { ...model, baseUrl };
    }
    
    return model;
  } catch {
    // Fallback to anthropic
    return getModel('anthropic', 'claude-sonnet-4-20250514' as any);
  }
}

/**
 * Show the provider settings dialog.
 * Returns a promise that resolves when the user saves settings.
 */
export function showProviderSettings(): Promise<void> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'dialog-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'dialog';
    dialog.style.cssText = 'max-width: 480px; width: 90vw;';

    const title = document.createElement('div');
    title.className = 'dialog__title';
    title.textContent = 'Provider Settings';
    dialog.appendChild(title);

    // Provider selector
    const providerLabel = document.createElement('div');
    providerLabel.className = 'dialog__desc';
    providerLabel.textContent = 'Select provider:';
    dialog.appendChild(providerLabel);

    const providerSelect = document.createElement('select');
    providerSelect.className = 'dialog__input';
    providerSelect.style.marginBottom = '16px';

    const providers = getAvailableProviders();
    const currentProvider = getSelectedProvider();

    // Group providers: configured first, then alphabetically
    const configuredProviders = providers.filter(p => p in PROVIDER_CONFIGS);
    const otherProviders = providers.filter(p => !(p in PROVIDER_CONFIGS));

    for (const providerId of [...configuredProviders, ...otherProviders]) {
      const config = getProviderConfig(providerId);
      const opt = document.createElement('option');
      opt.value = providerId;
      opt.textContent = config.name;
      if (providerId === currentProvider) opt.selected = true;
      providerSelect.appendChild(opt);
    }
    dialog.appendChild(providerSelect);

    // Provider description
    const providerDesc = document.createElement('div');
    providerDesc.className = 'dialog__desc';
    providerDesc.style.cssText = 'font-size: 12px; color: #888; margin-bottom: 16px; margin-top: -12px;';
    dialog.appendChild(providerDesc);

    // API Key section
    const apiKeySection = document.createElement('div');

    const apiKeyLabel = document.createElement('div');
    apiKeyLabel.className = 'dialog__desc';
    apiKeySection.appendChild(apiKeyLabel);

    const apiKeyInput = document.createElement('input');
    apiKeyInput.className = 'dialog__input';
    apiKeyInput.type = 'password';
    apiKeyInput.autocomplete = 'off';
    apiKeyInput.spellcheck = false;
    apiKeySection.appendChild(apiKeyInput);

    dialog.appendChild(apiKeySection);

    // Base URL section
    const baseUrlSection = document.createElement('div');
    baseUrlSection.style.marginTop = '12px';

    const baseUrlLabel = document.createElement('div');
    baseUrlLabel.className = 'dialog__desc';
    baseUrlSection.appendChild(baseUrlLabel);

    const baseUrlInput = document.createElement('input');
    baseUrlInput.className = 'dialog__input';
    baseUrlInput.type = 'text';
    baseUrlInput.autocomplete = 'off';
    baseUrlInput.spellcheck = false;
    baseUrlSection.appendChild(baseUrlInput);

    const baseUrlDesc = document.createElement('div');
    baseUrlDesc.className = 'dialog__desc';
    baseUrlDesc.style.cssText = 'font-size: 11px; color: #666; margin-top: 4px;';
    baseUrlSection.appendChild(baseUrlDesc);

    dialog.appendChild(baseUrlSection);

    // Model selector
    const modelSection = document.createElement('div');
    modelSection.style.marginTop = '16px';

    const modelLabel = document.createElement('div');
    modelLabel.className = 'dialog__desc';
    modelLabel.textContent = 'Model:';
    modelSection.appendChild(modelLabel);

    const modelSelect = document.createElement('select');
    modelSelect.className = 'dialog__input';
    modelSection.appendChild(modelSelect);

    const modelCount = document.createElement('div');
    modelCount.className = 'dialog__desc';
    modelCount.style.cssText = 'font-size: 11px; color: #666; margin-top: 4px;';
    modelSection.appendChild(modelCount);

    dialog.appendChild(modelSection);

    // Update UI based on selected provider
    function updateProviderUI() {
      const providerId = providerSelect.value;
      const config = getProviderConfig(providerId);

      // Update description
      providerDesc.textContent = config.description;

      // Update API key section
      apiKeyLabel.textContent = `API Key${config.apiKeyEnvVar ? ` (${config.apiKeyEnvVar})` : ''}:`;
      apiKeyInput.placeholder = config.apiKeyPlaceholder || 'API key';
      apiKeySection.style.display = config.requiresApiKey ? '' : 'none';

      // Update base URL section
      baseUrlLabel.textContent = config.baseUrlDescription || 'Base URL:';
      baseUrlInput.placeholder = config.baseUrlPlaceholder || 'https://...';
      baseUrlDesc.textContent = config.baseUrlDescription || '';
      baseUrlSection.style.display = config.requiresBaseUrl ? '' : 'none';

      // Update model list
      updateModelList();
    }

    function updateModelList() {
      const providerId = providerSelect.value;
      const models = getProviderModels(providerId);
      const currentModelId = getSelectedModelId();

      // Clear existing options
      while (modelSelect.firstChild) modelSelect.removeChild(modelSelect.firstChild);

      if (models.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'No models available';
        modelSelect.appendChild(opt);
        modelCount.textContent = '';
        return;
      }

      // Sort models: reasoning models first, then by name
      const sorted = [...models].sort((a, b) => {
        if (a.reasoning !== b.reasoning) return a.reasoning ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      for (const model of sorted) {
        const opt = document.createElement('option');
        opt.value = model.id;
        opt.textContent = model.name + (model.reasoning ? ' (reasoning)' : '');
        if (model.id === currentModelId) opt.selected = true;
        modelSelect.appendChild(opt);
      }

      // Select first if current not found
      if (!currentModelId || !models.find(m => m.id === currentModelId)) {
        modelSelect.selectedIndex = 0;
      }

      modelCount.textContent = `${models.length} models available`;
    }

    // Pre-fill existing values
    const existingKey = getApiKey();
    if (existingKey) apiKeyInput.value = existingKey;

    const existingUrl = getBaseUrl();
    if (existingUrl) baseUrlInput.value = existingUrl;

    providerSelect.addEventListener('change', updateProviderUI);
    updateProviderUI();

    // Submit button
    const btn = document.createElement('button');
    btn.className = 'dialog__btn';
    btn.style.marginTop = '20px';
    btn.textContent = 'Save';

    function validateAndSave() {
      const providerId = providerSelect.value;
      const config = getProviderConfig(providerId);

      // Validate API key if required
      if (config.requiresApiKey && apiKeyInput.value.trim().length < 5) {
        apiKeyInput.focus();
        return;
      }

      // Validate base URL if required
      if (config.requiresBaseUrl && !baseUrlInput.value.trim()) {
        baseUrlInput.focus();
        return;
      }

      // Save settings
      setSelectedProvider(providerId);
      if (config.requiresApiKey) {
        setApiKey(apiKeyInput.value.trim());
      }
      if (config.requiresBaseUrl) {
        setBaseUrl(baseUrlInput.value.trim());
      } else {
        clearBaseUrl();
      }
      setSelectedModelId(modelSelect.value);

      overlay.remove();
      resolve();
    }

    btn.addEventListener('click', validateAndSave);

    // Handle Enter key
    const handleEnter = (e: KeyboardEvent) => {
      if (e.key === 'Enter') validateAndSave();
    };
    apiKeyInput.addEventListener('keydown', handleEnter);
    baseUrlInput.addEventListener('keydown', handleEnter);

    dialog.appendChild(btn);

    // Cancel button (if already configured)
    if (getApiKey()) {
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'dialog__btn';
      cancelBtn.style.cssText = 'margin-top: 8px; background: transparent; border: 1px solid #444;';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', () => {
        overlay.remove();
        resolve();
      });
      dialog.appendChild(cancelBtn);
    }

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    requestAnimationFrame(() => apiKeyInput.focus());
  });
}

// Re-export for backward compatibility
export { getApiKey as getApiKeyCompat };
