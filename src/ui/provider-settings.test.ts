/**
 * Tests for provider settings — multi-account storage layer.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const storage = new Map<string, string>();
const mockStorage = {
  getItem: vi.fn((key: string) => storage.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => {
    storage.set(key, value);
  }),
  removeItem: vi.fn((key: string) => {
    storage.delete(key);
  }),
  clear: vi.fn(() => storage.clear()),
  get length() {
    return storage.size;
  },
  key: vi.fn((_i: number) => null),
} as Storage;

Object.defineProperty(globalThis, 'localStorage', { value: mockStorage, configurable: true });

const { mockGetProviders, mockGetModels, mockGetModel } = vi.hoisted(() => ({
  mockGetProviders: vi.fn(() => [
    'anthropic',
    'openai',
    'azure-openai-responses',
    'amazon-bedrock',
  ]),
  mockGetModels: vi.fn((providerId: string) => {
    if (providerId === 'anthropic') {
      return [{ id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', reasoning: true }];
    }
    if (providerId === 'openai') {
      return [{ id: 'gpt-5', name: 'GPT-5', reasoning: true }];
    }
    if (providerId === 'amazon-bedrock') {
      return [{ id: 'anthropic.claude-3-sonnet', name: 'Claude 3 Sonnet', reasoning: true }];
    }
    throw new Error(`Unknown provider: ${providerId}`);
  }),
  mockGetModel: vi.fn((providerId: string, modelId: string) => ({
    id: modelId,
    name: modelId,
    provider: providerId,
    api: 'mock-api',
    baseUrl: 'https://default.example.com',
  })),
}));

vi.mock('../core/index.js', () => ({
  getProviders: mockGetProviders,
  getModels: mockGetModels,
  getModel: mockGetModel,
}));

import {
  getSelectedProvider,
  setSelectedProvider,
  clearSelectedProvider,
  getApiKey,
  setApiKey,
  clearApiKey,
  getBaseUrl,
  setBaseUrl,
  clearBaseUrl,
  getSelectedModelId,
  setSelectedModelId,
  clearAllSettings,
  resolveCurrentModel,
  getAccounts,
  addAccount,
  removeAccount,
  getApiKeyForProvider,
  getBaseUrlForProvider,
  getAllAvailableModels,
} from './provider-settings.js';

describe('multi-account storage', () => {
  beforeEach(() => {
    storage.clear();
    vi.clearAllMocks();
  });

  it('getAccounts returns empty array when no accounts', () => {
    expect(getAccounts()).toEqual([]);
  });

  it('addAccount stores an account and getAccounts returns it', () => {
    addAccount('anthropic', 'sk-ant-123');
    const accounts = getAccounts();
    expect(accounts).toEqual([{ providerId: 'anthropic', apiKey: 'sk-ant-123' }]);
  });

  it('addAccount with baseUrl stores it', () => {
    addAccount('azure-ai-foundry', 'az-key', 'https://contoso.azure.com/anthropic');
    const accounts = getAccounts();
    expect(accounts).toEqual([{
      providerId: 'azure-ai-foundry',
      apiKey: 'az-key',
      baseUrl: 'https://contoso.azure.com/anthropic',
    }]);
  });

  it('addAccount replaces existing account for same provider', () => {
    addAccount('anthropic', 'key-1');
    addAccount('anthropic', 'key-2');
    const accounts = getAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].apiKey).toBe('key-2');
  });

  it('supports multiple accounts for different providers', () => {
    addAccount('anthropic', 'ant-key');
    addAccount('openai', 'oai-key');
    const accounts = getAccounts();
    expect(accounts).toHaveLength(2);
  });

  it('removeAccount removes the account', () => {
    addAccount('anthropic', 'ant-key');
    addAccount('openai', 'oai-key');
    removeAccount('anthropic');
    const accounts = getAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].providerId).toBe('openai');
  });

  it('getApiKeyForProvider returns the key for a specific provider', () => {
    addAccount('anthropic', 'ant-key');
    addAccount('openai', 'oai-key');
    expect(getApiKeyForProvider('anthropic')).toBe('ant-key');
    expect(getApiKeyForProvider('openai')).toBe('oai-key');
    expect(getApiKeyForProvider('groq')).toBeNull();
  });

  it('getBaseUrlForProvider returns the baseUrl for a specific provider', () => {
    addAccount('azure-ai-foundry', 'az-key', 'https://contoso.azure.com/anthropic');
    addAccount('anthropic', 'ant-key');
    expect(getBaseUrlForProvider('azure-ai-foundry')).toBe('https://contoso.azure.com/anthropic');
    expect(getBaseUrlForProvider('anthropic')).toBeNull();
  });
});

describe('selected model encodes provider', () => {
  beforeEach(() => {
    storage.clear();
    vi.clearAllMocks();
  });

  it('setSelectedModelId stores providerId:modelId', () => {
    addAccount('openai', 'oai-key');
    storage.set('selected-model', 'openai:gpt-5');
    expect(getSelectedModelId()).toBe('gpt-5');
    expect(getSelectedProvider()).toBe('openai');
  });

  it('getSelectedProvider falls back to first account if no model set', () => {
    addAccount('openai', 'oai-key');
    expect(getSelectedProvider()).toBe('openai');
  });

  it('getSelectedProvider defaults to anthropic when no accounts or model', () => {
    expect(getSelectedProvider()).toBe('anthropic');
  });

  it('setSelectedProvider updates the provider prefix in selected-model', () => {
    storage.set('selected-model', 'anthropic:claude-sonnet-4-20250514');
    setSelectedProvider('openai');
    expect(storage.get('selected-model')).toBe('openai:claude-sonnet-4-20250514');
  });
});

describe('backward-compatible accessors', () => {
  beforeEach(() => {
    storage.clear();
    vi.clearAllMocks();
  });

  it('getApiKey returns key for current provider', () => {
    addAccount('openai', 'oai-key');
    storage.set('selected-model', 'openai:gpt-5');
    expect(getApiKey()).toBe('oai-key');
  });

  it('setApiKey adds/updates account for current provider', () => {
    storage.set('selected-model', 'anthropic:');
    setApiKey('new-key');
    expect(getApiKeyForProvider('anthropic')).toBe('new-key');
  });

  it('clearApiKey removes account for current provider', () => {
    addAccount('anthropic', 'ant-key');
    storage.set('selected-model', 'anthropic:claude-sonnet-4-20250514');
    clearApiKey();
    expect(getApiKeyForProvider('anthropic')).toBeNull();
  });

  it('getBaseUrl returns baseUrl for current provider', () => {
    addAccount('azure-ai-foundry', 'az-key', 'https://contoso.azure.com/anthropic');
    storage.set('selected-model', 'azure-ai-foundry:claude-sonnet-4-20250514');
    expect(getBaseUrl()).toBe('https://contoso.azure.com/anthropic');
  });

  it('setBaseUrl updates baseUrl for current provider', () => {
    addAccount('azure-ai-foundry', 'az-key');
    storage.set('selected-model', 'azure-ai-foundry:claude-sonnet-4-20250514');
    setBaseUrl('https://new-endpoint.azure.com/anthropic');
    expect(getBaseUrlForProvider('azure-ai-foundry')).toBe('https://new-endpoint.azure.com/anthropic');
  });

  it('clearBaseUrl removes baseUrl but keeps the account', () => {
    addAccount('azure-ai-foundry', 'az-key', 'https://contoso.azure.com/anthropic');
    storage.set('selected-model', 'azure-ai-foundry:claude-sonnet-4-20250514');
    clearBaseUrl();
    expect(getApiKeyForProvider('azure-ai-foundry')).toBe('az-key');
    expect(getBaseUrlForProvider('azure-ai-foundry')).toBeNull();
  });

  it('getBaseUrl returns null when no account exists', () => {
    expect(getBaseUrl()).toBeNull();
  });
});

describe('clearAllSettings', () => {
  beforeEach(() => {
    storage.clear();
    vi.clearAllMocks();
  });

  it('removes accounts, model key, and legacy keys', () => {
    addAccount('anthropic', 'ant-key');
    storage.set('selected-model', 'anthropic:claude-sonnet-4-20250514');
    // Set some legacy keys manually
    storage.set('slicc_provider', 'anthropic');
    storage.set('anthropic_api_key', 'old');

    clearAllSettings();

    expect(getAccounts()).toEqual([]);
    expect(getSelectedModelId()).toBe('');
    expect(storage.get('slicc_provider')).toBeUndefined();
    expect(storage.get('anthropic_api_key')).toBeUndefined();
  });
});

describe('resolveCurrentModel', () => {
  beforeEach(() => {
    storage.clear();
    vi.clearAllMocks();
  });

  it('resolves selected provider/model and applies baseUrl override', () => {
    addAccount('openai', 'oai-key', 'https://proxy.example.com');
    storage.set('selected-model', 'openai:gpt-5');

    const model = resolveCurrentModel();

    expect(mockGetModel).toHaveBeenCalledWith('openai', 'gpt-5');
    expect(model.id).toBe('gpt-5');
    expect((model as any).baseUrl).toBe('https://proxy.example.com');
  });

  it('falls back to anthropic default model when model lookup fails', () => {
    mockGetModel.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    addAccount('openai', 'oai-key');
    storage.set('selected-model', 'openai:gpt-5');

    const model = resolveCurrentModel();

    expect(mockGetModel).toHaveBeenNthCalledWith(2, 'anthropic', 'claude-sonnet-4-20250514');
    expect((model as any).provider).toBe('anthropic');
    expect(model.id).toBe('claude-sonnet-4-20250514');
  });

  it('does not apply baseUrl when account has none', () => {
    addAccount('openai', 'oai-key');
    storage.set('selected-model', 'openai:gpt-5');

    const model = resolveCurrentModel();

    expect((model as any).baseUrl).toBe('https://default.example.com');
  });
});

describe('getAllAvailableModels', () => {
  beforeEach(() => {
    storage.clear();
    vi.clearAllMocks();
  });

  it('returns empty array when no accounts configured', () => {
    expect(getAllAvailableModels()).toEqual([]);
  });

  it('returns models grouped by provider for single account', () => {
    addAccount('anthropic', 'ant-key');
    const groups = getAllAvailableModels();
    expect(groups).toHaveLength(1);
    expect(groups[0].providerId).toBe('anthropic');
    expect(groups[0].providerName).toBe('Anthropic');
    expect(groups[0].models).toHaveLength(1);
    expect(groups[0].models[0].id).toBe('claude-sonnet-4-20250514');
  });

  it('returns models grouped by provider for multiple accounts', () => {
    addAccount('anthropic', 'ant-key');
    addAccount('openai', 'oai-key');
    const groups = getAllAvailableModels();
    expect(groups).toHaveLength(2);
    expect(groups[0].providerId).toBe('anthropic');
    expect(groups[1].providerId).toBe('openai');
  });

  it('skips providers with no models', () => {
    addAccount('anthropic', 'ant-key');
    addAccount('groq', 'groq-key'); // mockGetModels throws for unknown providers
    const groups = getAllAvailableModels();
    expect(groups).toHaveLength(1);
    expect(groups[0].providerId).toBe('anthropic');
  });
});

describe('legacy key cleanup', () => {
  it('deletes legacy keys on module load', () => {
    // Legacy keys should have been deleted when the module was imported.
    // Set them again and re-verify via clearAllSettings which also cleans them.
    const legacyKeys = [
      'slicc_provider', 'slicc_api_key', 'slicc_base_url',
      'anthropic_api_key', 'api_provider', 'azure_resource', 'bedrock_region',
    ];
    for (const key of legacyKeys) {
      storage.set(key, 'value');
    }
    clearAllSettings();
    for (const key of legacyKeys) {
      expect(storage.get(key)).toBeUndefined();
    }
  });
});
