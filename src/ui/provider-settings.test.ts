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

const { mockGetProviders, mockGetModels, mockGetModel, mockCreateLogger, mockLog } = vi.hoisted(() => {
  const mockLog = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return {
    mockLog,
    mockCreateLogger: vi.fn(() => mockLog),
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
  };
});

vi.mock('../core/index.js', () => ({
  getProviders: mockGetProviders,
  getModels: mockGetModels,
  getModel: mockGetModel,
  createLogger: mockCreateLogger,
}));

// Mock the providers/index.js module — return a minimal set of registered providers
const { mockGetRegisteredProviderConfig, mockGetRegisteredProviderIds } = vi.hoisted(() => {
  const providerConfigs = new Map([
    ['anthropic', { id: 'anthropic', name: 'Anthropic', description: 'Claude', requiresApiKey: true, requiresBaseUrl: false }],
    ['openai', { id: 'openai', name: 'OpenAI', description: 'GPT', requiresApiKey: true, requiresBaseUrl: false }],
    ['bedrock-camp', { id: 'bedrock-camp', name: 'AWS Bedrock (CAMP)', description: 'CAMP', requiresApiKey: true, requiresBaseUrl: true }],
    ['azure-ai-foundry', { id: 'azure-ai-foundry', name: 'Azure (Claude)', description: 'Azure', requiresApiKey: true, requiresBaseUrl: true }],
    ['amazon-bedrock', { id: 'amazon-bedrock', name: 'AWS Bedrock', description: 'Bedrock', requiresApiKey: true, requiresBaseUrl: true }],
    ['azure-openai-responses', { id: 'azure-openai-responses', name: 'Azure (OpenAI)', description: 'Azure OpenAI', requiresApiKey: true, requiresBaseUrl: true }],
    ['test-oauth', { id: 'test-oauth', name: 'Test OAuth', description: 'OAuth test provider', requiresApiKey: false, requiresBaseUrl: false, isOAuth: true }],
  ]);
  return {
    mockGetRegisteredProviderConfig: vi.fn((id: string) => providerConfigs.get(id)),
    mockGetRegisteredProviderIds: vi.fn(() => [...providerConfigs.keys()]),
  };
});

vi.mock('../providers/index.js', () => ({
  getRegisteredProviderConfig: mockGetRegisteredProviderConfig,
  getRegisteredProviderIds: mockGetRegisteredProviderIds,
  shouldIncludeProvider: () => true,
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
  applyProviderDefaults,
  exportProviders,
  getAvailableProviders,
  getProviderConfig,
  saveOAuthAccount,
} from './provider-settings.js';
import type { ProviderDefault } from './provider-settings.js';

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
    expect((model as unknown as Record<string, unknown>).baseUrl).toBe('https://proxy.example.com');
  });

  it('falls back to anthropic default model when model lookup fails', () => {
    mockGetModel.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    addAccount('openai', 'oai-key');
    storage.set('selected-model', 'openai:gpt-5');

    const model = resolveCurrentModel();

    expect(mockGetModel).toHaveBeenNthCalledWith(2, 'anthropic', 'claude-sonnet-4-20250514');
    expect((model as unknown as Record<string, unknown>).provider).toBe('anthropic');
    expect(model.id).toBe('claude-sonnet-4-20250514');
  });

  it('does not apply baseUrl when account has none', () => {
    addAccount('openai', 'oai-key');
    storage.set('selected-model', 'openai:gpt-5');

    const model = resolveCurrentModel();

    expect((model as unknown as Record<string, unknown>).baseUrl).toBe('https://default.example.com');
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
  it('deletes legacy keys via clearAllSettings', () => {
    // clearAllSettings removes legacy keys along with accounts and model key.
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

describe('applyProviderDefaults', () => {
  beforeEach(() => {
    storage.clear();
    vi.clearAllMocks();
  });

  it('no-op when defaults array is empty', () => {
    applyProviderDefaults([]);
    expect(getAccounts()).toEqual([]);
  });

  it('no-op when accounts already exist', () => {
    addAccount('openai', 'existing-key');
    const defaults: ProviderDefault[] = [
      { providerId: 'anthropic', apiKey: 'new-key' },
    ];
    applyProviderDefaults(defaults);
    const accounts = getAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].providerId).toBe('openai');
  });

  it('adds accounts from defaults when none exist', () => {
    const defaults: ProviderDefault[] = [
      { providerId: 'anthropic', apiKey: 'ant-key' },
      { providerId: 'openai', apiKey: 'oai-key' },
    ];
    applyProviderDefaults(defaults);
    const accounts = getAccounts();
    expect(accounts).toHaveLength(2);
    expect(accounts[0].providerId).toBe('anthropic');
    expect(accounts[1].providerId).toBe('openai');
  });

  it('sets selected model from first entry', () => {
    const defaults: ProviderDefault[] = [
      { providerId: 'anthropic', apiKey: 'ant-key', model: 'claude-sonnet-4-20250514' },
      { providerId: 'openai', apiKey: 'oai-key', model: 'gpt-5' },
    ];
    applyProviderDefaults(defaults);
    expect(getSelectedModelId()).toBe('claude-sonnet-4-20250514');
    expect(getSelectedProvider()).toBe('anthropic');
  });

  it('skips entries missing providerId or apiKey', () => {
    const defaults: ProviderDefault[] = [
      { providerId: '', apiKey: 'key-1' },
      { providerId: 'anthropic', apiKey: '' },
      { providerId: 'openai', apiKey: 'oai-key' },
    ];
    applyProviderDefaults(defaults);
    const accounts = getAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].providerId).toBe('openai');
  });

  it('warns and skips unknown providers', () => {
    const defaults: ProviderDefault[] = [
      { providerId: 'unknown-provider', apiKey: 'key-1' },
      { providerId: 'anthropic', apiKey: 'ant-key' },
    ];
    applyProviderDefaults(defaults);
    const accounts = getAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].providerId).toBe('anthropic');
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.stringContaining('unknown-provider'),
    );
  });

  it('stores baseUrl when provided', () => {
    const defaults: ProviderDefault[] = [
      {
        providerId: 'amazon-bedrock',
        apiKey: 'aws-key',
        baseUrl: 'https://bedrock.us-east-1.amazonaws.com',
      },
    ];
    applyProviderDefaults(defaults);
    expect(getBaseUrlForProvider('amazon-bedrock')).toBe('https://bedrock.us-east-1.amazonaws.com');
  });

  it('makes getApiKey() return non-null (skips settings dialog)', () => {
    const defaults: ProviderDefault[] = [
      { providerId: 'anthropic', apiKey: 'ant-key', model: 'claude-sonnet-4-20250514' },
    ];
    applyProviderDefaults(defaults);
    expect(getApiKey()).toBe('ant-key');
    expect(getSelectedProvider()).toBe('anthropic');
  });

  it('duplicate providerId keeps last entry', () => {
    const defaults: ProviderDefault[] = [
      { providerId: 'anthropic', apiKey: 'first-key' },
      { providerId: 'anthropic', apiKey: 'second-key' },
    ];
    applyProviderDefaults(defaults);
    expect(getApiKeyForProvider('anthropic')).toBe('second-key');
    expect(getAccounts()).toHaveLength(1);
  });

  it('does not override existing selected model', () => {
    storage.set('selected-model', 'openai:gpt-5');
    const defaults: ProviderDefault[] = [
      { providerId: 'anthropic', apiKey: 'ant-key', model: 'claude-sonnet-4-20250514' },
    ];
    applyProviderDefaults(defaults);
    expect(storage.get('selected-model')).toBe('openai:gpt-5');
  });
});

describe('exportProviders', () => {
  beforeEach(() => {
    storage.clear();
    vi.clearAllMocks();
  });

  it('returns empty array when no accounts', () => {
    expect(exportProviders()).toEqual([]);
  });

  it('exports all accounts with providerId and apiKey', () => {
    addAccount('anthropic', 'ant-key');
    addAccount('openai', 'oai-key');
    const result = exportProviders();
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ providerId: 'anthropic', apiKey: 'ant-key' });
    expect(result[1]).toEqual({ providerId: 'openai', apiKey: 'oai-key' });
  });

  it('includes baseUrl only when present', () => {
    addAccount('anthropic', 'ant-key');
    addAccount('azure-ai-foundry', 'az-key', 'https://contoso.azure.com/anthropic');
    const result = exportProviders();
    expect(result[0].baseUrl).toBeUndefined();
    expect(result[1].baseUrl).toBe('https://contoso.azure.com/anthropic');
  });

  it('attaches model to matching selected provider', () => {
    addAccount('anthropic', 'ant-key');
    addAccount('openai', 'oai-key');
    storage.set('selected-model', 'openai:gpt-5');
    const result = exportProviders();
    expect(result[0].model).toBeUndefined();
    expect(result[1].model).toBe('gpt-5');
  });

  it('omits model when no model is selected', () => {
    addAccount('anthropic', 'ant-key');
    const result = exportProviders();
    expect(result[0].model).toBeUndefined();
  });

  it('round-trips with applyProviderDefaults', () => {
    addAccount('anthropic', 'ant-key');
    addAccount('openai', 'oai-key', 'https://proxy.example.com');
    storage.set('selected-model', 'anthropic:claude-sonnet-4-20250514');

    const exported = exportProviders();

    // Clear and re-apply
    storage.clear();
    applyProviderDefaults(exported);

    expect(getAccounts()).toHaveLength(2);
    expect(getApiKeyForProvider('anthropic')).toBe('ant-key');
    expect(getApiKeyForProvider('openai')).toBe('oai-key');
    expect(getBaseUrlForProvider('openai')).toBe('https://proxy.example.com');
    expect(getSelectedModelId()).toBe('claude-sonnet-4-20250514');
    expect(getSelectedProvider()).toBe('anthropic');
  });
});

describe('dynamic provider registry', () => {
  beforeEach(() => {
    storage.clear();
    vi.clearAllMocks();
  });

  it('getAvailableProviders includes both pi-ai and registered providers', () => {
    const providers = getAvailableProviders();
    // Should include pi-ai providers AND registered providers (deduplicated)
    expect(providers).toContain('anthropic');
    expect(providers).toContain('openai');
    expect(providers).toContain('test-oauth'); // from registered providers, not pi-ai
  });

  it('getProviderConfig returns registered config', () => {
    const config = getProviderConfig('anthropic');
    expect(config.id).toBe('anthropic');
    expect(config.name).toBe('Anthropic');
  });

  it('getProviderConfig returns fallback for unknown providers', () => {
    const config = getProviderConfig('unknown-provider');
    expect(config.id).toBe('unknown-provider');
    expect(config.name).toBe('Unknown Provider');
    expect(config.requiresApiKey).toBe(true);
  });

  it('getProviderConfig returns isOAuth for OAuth providers', () => {
    const config = getProviderConfig('test-oauth');
    expect(config.isOAuth).toBe(true);
    expect(config.requiresApiKey).toBe(false);
  });
});

describe('OAuth account storage', () => {
  beforeEach(() => {
    storage.clear();
    vi.clearAllMocks();
  });

  it('saveOAuthAccount stores OAuth fields', () => {
    saveOAuthAccount({
      providerId: 'test-oauth',
      accessToken: 'token-123',
      refreshToken: 'refresh-456',
      tokenExpiresAt: Date.now() + 86400000,
      userName: 'karl@example.com',
    });
    const accounts = getAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].providerId).toBe('test-oauth');
    expect(accounts[0].accessToken).toBe('token-123');
    expect(accounts[0].refreshToken).toBe('refresh-456');
    expect(accounts[0].userName).toBe('karl@example.com');
    expect(accounts[0].apiKey).toBe(''); // OAuth providers don't use API keys
  });

  it('getApiKeyForProvider returns accessToken for OAuth providers', () => {
    saveOAuthAccount({
      providerId: 'test-oauth',
      accessToken: 'oauth-token-xyz',
    });
    // The key bridge: getApiKeyForProvider returns the access token
    expect(getApiKeyForProvider('test-oauth')).toBe('oauth-token-xyz');
  });

  it('getApiKeyForProvider prefers accessToken over apiKey', () => {
    // Simulate an account with both (shouldn't happen in practice)
    const accounts = getAccounts();
    accounts.push({
      providerId: 'hybrid',
      apiKey: 'old-key',
      accessToken: 'new-token',
    });
    storage.set('slicc_accounts', JSON.stringify(accounts));
    expect(getApiKeyForProvider('hybrid')).toBe('new-token');
  });

  it('getApiKeyForProvider falls back to apiKey when no accessToken', () => {
    addAccount('anthropic', 'sk-ant-123');
    expect(getApiKeyForProvider('anthropic')).toBe('sk-ant-123');
  });

  it('saveOAuthAccount replaces existing account for same provider', () => {
    saveOAuthAccount({ providerId: 'test-oauth', accessToken: 'token-1' });
    saveOAuthAccount({ providerId: 'test-oauth', accessToken: 'token-2', userName: 'updated@example.com' });
    const accounts = getAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].accessToken).toBe('token-2');
    expect(accounts[0].userName).toBe('updated@example.com');
  });
});
