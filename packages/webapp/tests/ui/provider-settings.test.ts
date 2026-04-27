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

const { mockGetProviders, mockGetModels, mockGetModel, mockCreateLogger, mockLog } = vi.hoisted(
  () => {
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
          return [{ id: 'claude-sonnet-4-0', name: 'Claude Sonnet 4', reasoning: true }];
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
  }
);

vi.mock('../../src/core/index.js', () => ({
  getProviders: mockGetProviders,
  getModels: mockGetModels,
  getModel: mockGetModel,
  createLogger: mockCreateLogger,
}));

// Mock the providers/index.js module — return a minimal set of registered providers
const { mockGetRegisteredProviderConfig, mockGetRegisteredProviderIds } = vi.hoisted(() => {
  const providerConfigs = new Map<string, Record<string, unknown>>([
    [
      'anthropic',
      {
        id: 'anthropic',
        name: 'Anthropic',
        description: 'Claude',
        requiresApiKey: true,
        requiresBaseUrl: false,
      },
    ],
    [
      'openai',
      {
        id: 'openai',
        name: 'OpenAI',
        description: 'GPT',
        requiresApiKey: true,
        requiresBaseUrl: false,
      },
    ],
    [
      'bedrock-camp',
      {
        id: 'bedrock-camp',
        name: 'AWS Bedrock (CAMP)',
        description: 'CAMP',
        requiresApiKey: true,
        requiresBaseUrl: true,
      },
    ],
    [
      'azure-ai-foundry',
      {
        id: 'azure-ai-foundry',
        name: 'Azure (Claude)',
        description: 'Azure',
        requiresApiKey: true,
        requiresBaseUrl: true,
      },
    ],
    [
      'amazon-bedrock',
      {
        id: 'amazon-bedrock',
        name: 'AWS Bedrock',
        description: 'Bedrock',
        requiresApiKey: true,
        requiresBaseUrl: true,
      },
    ],
    [
      'azure-openai-responses',
      {
        id: 'azure-openai-responses',
        name: 'Azure (OpenAI)',
        description: 'Azure OpenAI',
        requiresApiKey: true,
        requiresBaseUrl: true,
      },
    ],
    [
      'test-oauth',
      {
        id: 'test-oauth',
        name: 'Test OAuth',
        description: 'OAuth test provider',
        requiresApiKey: false,
        requiresBaseUrl: false,
        isOAuth: true,
      },
    ],
  ]);
  return {
    mockGetRegisteredProviderConfig: vi.fn((id: string) => providerConfigs.get(id)),
    mockGetRegisteredProviderIds: vi.fn(() => [...providerConfigs.keys()]),
  };
});

vi.mock('../../src/providers/index.js', () => ({
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
  getProviderModels,
  resolveModelById,
  saveOAuthAccount,
  getOAuthAccountInfo,
} from '../../src/ui/provider-settings.js';
import type { ProviderDefault } from '../../src/ui/provider-settings.js';

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
    expect(accounts).toEqual([
      {
        providerId: 'azure-ai-foundry',
        apiKey: 'az-key',
        baseUrl: 'https://contoso.azure.com/anthropic',
      },
    ]);
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
    storage.set('selected-model', 'anthropic:claude-sonnet-4-0');
    setSelectedProvider('openai');
    expect(storage.get('selected-model')).toBe('openai:claude-sonnet-4-0');
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
    storage.set('selected-model', 'anthropic:claude-sonnet-4-0');
    clearApiKey();
    expect(getApiKeyForProvider('anthropic')).toBeNull();
  });

  it('getBaseUrl returns baseUrl for current provider', () => {
    addAccount('azure-ai-foundry', 'az-key', 'https://contoso.azure.com/anthropic');
    storage.set('selected-model', 'azure-ai-foundry:claude-sonnet-4-0');
    expect(getBaseUrl()).toBe('https://contoso.azure.com/anthropic');
  });

  it('setBaseUrl updates baseUrl for current provider', () => {
    addAccount('azure-ai-foundry', 'az-key');
    storage.set('selected-model', 'azure-ai-foundry:claude-sonnet-4-0');
    setBaseUrl('https://new-endpoint.azure.com/anthropic');
    expect(getBaseUrlForProvider('azure-ai-foundry')).toBe(
      'https://new-endpoint.azure.com/anthropic'
    );
  });

  it('clearBaseUrl removes baseUrl but keeps the account', () => {
    addAccount('azure-ai-foundry', 'az-key', 'https://contoso.azure.com/anthropic');
    storage.set('selected-model', 'azure-ai-foundry:claude-sonnet-4-0');
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
    storage.set('selected-model', 'anthropic:claude-sonnet-4-0');
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

  it('falls back to provider custom model when registry lookup fails', () => {
    mockGetModel.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    addAccount('openai', 'oai-key');
    storage.set('selected-model', 'openai:gpt-5');

    const model = resolveCurrentModel();

    // Should fall back to provider's own model from getProviderModels, not hardcoded anthropic
    expect(model.id).toBe('gpt-5');
  });

  it('falls back to anthropic when provider has no matching model either', () => {
    mockGetModel.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    addAccount('openai', 'oai-key');
    storage.set('selected-model', 'openai:nonexistent-model');

    const model = resolveCurrentModel();

    expect(mockGetModel).toHaveBeenCalledWith('anthropic', 'claude-sonnet-4-0');
    expect(model.id).toBe('claude-sonnet-4-0');
  });

  it('does not apply baseUrl when account has none', () => {
    addAccount('openai', 'oai-key');
    storage.set('selected-model', 'openai:gpt-5');

    const model = resolveCurrentModel();

    expect((model as unknown as Record<string, unknown>).baseUrl).toBe(
      'https://default.example.com'
    );
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
    expect(groups[0].models[0].id).toBe('claude-sonnet-4-0');
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
      'slicc_provider',
      'slicc_api_key',
      'slicc_base_url',
      'anthropic_api_key',
      'api_provider',
      'azure_resource',
      'bedrock_region',
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
    const defaults: ProviderDefault[] = [{ providerId: 'anthropic', apiKey: 'new-key' }];
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
      { providerId: 'anthropic', apiKey: 'ant-key', model: 'claude-sonnet-4-0' },
      { providerId: 'openai', apiKey: 'oai-key', model: 'gpt-5' },
    ];
    applyProviderDefaults(defaults);
    expect(getSelectedModelId()).toBe('claude-sonnet-4-0');
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
    expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('unknown-provider'));
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
      { providerId: 'anthropic', apiKey: 'ant-key', model: 'claude-sonnet-4-0' },
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
      { providerId: 'anthropic', apiKey: 'ant-key', model: 'claude-sonnet-4-0' },
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
    storage.set('selected-model', 'anthropic:claude-sonnet-4-0');

    const exported = exportProviders();

    // Clear and re-apply
    storage.clear();
    applyProviderDefaults(exported);

    expect(getAccounts()).toHaveLength(2);
    expect(getApiKeyForProvider('anthropic')).toBe('ant-key');
    expect(getApiKeyForProvider('openai')).toBe('oai-key');
    expect(getBaseUrlForProvider('openai')).toBe('https://proxy.example.com');
    expect(getSelectedModelId()).toBe('claude-sonnet-4-0');
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
    saveOAuthAccount({
      providerId: 'test-oauth',
      accessToken: 'token-2',
      userName: 'updated@example.com',
    });
    const accounts = getAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].accessToken).toBe('token-2');
    expect(accounts[0].userName).toBe('updated@example.com');
  });

  it('saveOAuthAccount preserves existing baseUrl through re-login', () => {
    // First login: set baseUrl via addAccount (as the UI does before login)
    addAccount('test-oauth', '', 'https://proxy.example.com');
    // OAuth login stores token, should preserve baseUrl
    saveOAuthAccount({ providerId: 'test-oauth', accessToken: 'token-1', userName: 'karl' });
    const accounts = getAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].accessToken).toBe('token-1');
    expect(accounts[0].baseUrl).toBe('https://proxy.example.com');
  });

  it('saveOAuthAccount allows explicit baseUrl override', () => {
    addAccount('test-oauth', '', 'https://old-proxy.example.com');
    saveOAuthAccount({
      providerId: 'test-oauth',
      accessToken: 'token-1',
      baseUrl: 'https://new-proxy.example.com',
    });
    expect(getBaseUrlForProvider('test-oauth')).toBe('https://new-proxy.example.com');
  });

  it('saveOAuthAccount does not set baseUrl when none exists', () => {
    saveOAuthAccount({ providerId: 'test-oauth', accessToken: 'token-1' });
    const accounts = getAccounts();
    expect(accounts[0].baseUrl).toBeUndefined();
  });
});

describe('getOAuthAccountInfo', () => {
  beforeEach(() => {
    storage.clear();
    vi.clearAllMocks();
  });

  it('returns null when no account exists', () => {
    expect(getOAuthAccountInfo('nonexistent')).toBeNull();
  });

  it('returns null when account has no accessToken', () => {
    addAccount('anthropic', 'sk-ant-123');
    expect(getOAuthAccountInfo('anthropic')).toBeNull();
  });

  it('returns token info for OAuth account', () => {
    const expiresAt = Date.now() + 3600000;
    saveOAuthAccount({
      providerId: 'test-oauth',
      accessToken: 'tok-123',
      tokenExpiresAt: expiresAt,
      userName: 'karl@example.com',
    });
    const info = getOAuthAccountInfo('test-oauth');
    expect(info).not.toBeNull();
    expect(info!.token).toBe('tok-123');
    expect(info!.expiresAt).toBe(expiresAt);
    expect(info!.userName).toBe('karl@example.com');
    expect(info!.expired).toBe(false);
  });

  it('marks token as expired when past expiry minus 60s buffer', () => {
    saveOAuthAccount({
      providerId: 'test-oauth',
      accessToken: 'tok-expired',
      tokenExpiresAt: Date.now() - 1000, // expired 1s ago
    });
    const info = getOAuthAccountInfo('test-oauth');
    expect(info).not.toBeNull();
    expect(info!.expired).toBe(true);
  });

  it('marks token as expired when within 60s buffer', () => {
    saveOAuthAccount({
      providerId: 'test-oauth',
      accessToken: 'tok-almost',
      tokenExpiresAt: Date.now() + 30000, // 30s from now (within 60s buffer)
    });
    const info = getOAuthAccountInfo('test-oauth');
    expect(info!.expired).toBe(true);
  });

  it('returns expired false when no tokenExpiresAt', () => {
    saveOAuthAccount({
      providerId: 'test-oauth',
      accessToken: 'tok-forever',
    });
    const info = getOAuthAccountInfo('test-oauth');
    expect(info!.expired).toBe(false);
  });
});

describe('resolveCurrentModel with getModelIds', () => {
  beforeEach(() => {
    storage.clear();
    vi.clearAllMocks();
  });

  it('falls back to provider custom model when model ID not in pi-ai registry', () => {
    // Register a provider with getModelIds that returns a model not in the Anthropic registry
    const providerConfigs = new Map(
      mockGetRegisteredProviderIds().map((id: string) => [id, mockGetRegisteredProviderConfig(id)])
    );
    providerConfigs.set('custom-oauth', {
      id: 'custom-oauth',
      name: 'Custom OAuth',
      description: 'Test',
      requiresApiKey: false,
      requiresBaseUrl: false,
      isOAuth: true,
      getModelIds: () => [{ id: 'custom-model-not-in-registry', name: 'Custom Model' }],
    });
    mockGetRegisteredProviderConfig.mockImplementation((id: string) => providerConfigs.get(id));
    mockGetRegisteredProviderIds.mockReturnValue([...providerConfigs.keys()]);

    // Make getModelDynamic throw for unknown model (simulates pi-ai registry miss)
    mockGetModel.mockImplementation((provider: string, modelId: string) => {
      if (modelId === 'custom-model-not-in-registry') throw new Error('Unknown model');
      return {
        id: modelId,
        name: modelId,
        provider,
        api: 'mock-api',
        baseUrl: 'https://default.example.com',
      };
    });

    addAccount('custom-oauth', '');
    storage.set('selected-model', 'custom-oauth:custom-model-not-in-registry');

    const model = resolveCurrentModel();
    // Should use the custom model from getModelIds, NOT fall back to raw anthropic
    expect(model.id).toBe('custom-model-not-in-registry');
    expect(model.provider).toBe('custom-oauth');
    expect(model.api).toBe('custom-oauth-anthropic');
  });
});

describe('OAuth API routing uses api from getModelIds', () => {
  beforeEach(() => {
    storage.clear();
    vi.clearAllMocks();
  });

  function setupOAuthProviderWithMixedApis() {
    const providerConfigs = new Map(
      mockGetRegisteredProviderIds().map((id: string) => [id, mockGetRegisteredProviderConfig(id)])
    );
    providerConfigs.set('adobe', {
      id: 'adobe',
      name: 'Adobe',
      description: 'Adobe provider',
      requiresApiKey: false,
      requiresBaseUrl: false,
      isOAuth: true,
      getModelIds: () => [
        { id: 'claude-sonnet-4-0', name: 'Claude Sonnet 4' },
        { id: 'gpt-5', name: 'GPT-5', api: 'openai' },
      ],
    });
    mockGetRegisteredProviderConfig.mockImplementation((id: string) => providerConfigs.get(id));
    mockGetRegisteredProviderIds.mockReturnValue([...providerConfigs.keys()]);

    // pi-ai registry knows both base models
    mockGetModel.mockImplementation((provider: string, modelId: string) => ({
      id: modelId,
      name: modelId,
      provider,
      api: 'mock-api',
      baseUrl: 'https://default.example.com',
    }));

    saveOAuthAccount({ providerId: 'adobe', accessToken: 'tok-adobe' });
  }

  it('resolveCurrentModel returns correct api from getModelIds for anthropic model', () => {
    setupOAuthProviderWithMixedApis();
    storage.set('selected-model', 'adobe:claude-sonnet-4-0');

    const model = resolveCurrentModel();
    expect(model.id).toBe('claude-sonnet-4-0');
    expect(model.provider).toBe('adobe');
    expect(String(model.api)).toBe('adobe-anthropic');
  });

  it('resolveCurrentModel returns correct api from getModelIds for openai model', () => {
    setupOAuthProviderWithMixedApis();
    storage.set('selected-model', 'adobe:gpt-5');

    const model = resolveCurrentModel();
    expect(model.id).toBe('gpt-5');
    expect(model.provider).toBe('adobe');
    expect(String(model.api)).toBe('adobe-openai');
  });

  it('resolveModelById returns correct api from getModelIds for anthropic model', () => {
    setupOAuthProviderWithMixedApis();
    storage.set('selected-model', 'adobe:claude-sonnet-4-0');

    const model = resolveModelById('claude-sonnet-4-0');
    expect(model.id).toBe('claude-sonnet-4-0');
    expect(model.provider).toBe('adobe');
    expect(String(model.api)).toBe('adobe-anthropic');
  });

  it('resolveModelById returns correct api from getModelIds for openai model', () => {
    setupOAuthProviderWithMixedApis();
    storage.set('selected-model', 'adobe:gpt-5');

    const model = resolveModelById('gpt-5');
    expect(model.id).toBe('gpt-5');
    expect(model.provider).toBe('adobe');
    expect(String(model.api)).toBe('adobe-openai');
  });
});

describe('resolveCurrentModel with getModelDynamic returning undefined', () => {
  beforeEach(() => {
    storage.clear();
    vi.clearAllMocks();
  });

  it('falls back to custom model when getModelDynamic returns undefined instead of throwing', () => {
    const providerConfigs = new Map(
      mockGetRegisteredProviderIds().map((id: string) => [id, mockGetRegisteredProviderConfig(id)])
    );
    providerConfigs.set('custom-oauth', {
      id: 'custom-oauth',
      name: 'Custom OAuth',
      description: 'Test',
      requiresApiKey: false,
      requiresBaseUrl: false,
      isOAuth: true,
      getModelIds: () => [{ id: 'ghost-model', name: 'Ghost' }],
    });
    mockGetRegisteredProviderConfig.mockImplementation((id: string) => providerConfigs.get(id));
    mockGetRegisteredProviderIds.mockReturnValue([...providerConfigs.keys()]);

    // Simulate browser behavior: getModelDynamic returns undefined (not throws)
    mockGetModel.mockImplementation(((provider: string, modelId: string) => {
      if (modelId === 'ghost-model') return undefined;
      return {
        id: modelId,
        name: modelId,
        provider,
        api: 'mock-api',
        baseUrl: 'https://default.example.com',
      };
    }) as any);

    addAccount('custom-oauth', '');
    storage.set('selected-model', 'custom-oauth:ghost-model');

    const model = resolveCurrentModel();
    expect(model.id).toBe('ghost-model');
    expect(model.provider).toBe('custom-oauth');
    expect(model.api).toBe('custom-oauth-anthropic');
  });

  it('resolveModelById falls back when getModelDynamic returns undefined', () => {
    const providerConfigs = new Map(
      mockGetRegisteredProviderIds().map((id: string) => [id, mockGetRegisteredProviderConfig(id)])
    );
    providerConfigs.set('custom-oauth', {
      id: 'custom-oauth',
      name: 'Custom OAuth',
      description: 'Test',
      requiresApiKey: false,
      requiresBaseUrl: false,
      isOAuth: true,
      getModelIds: () => [{ id: 'ghost-model', name: 'Ghost' }],
    });
    mockGetRegisteredProviderConfig.mockImplementation((id: string) => providerConfigs.get(id));
    mockGetRegisteredProviderIds.mockReturnValue([...providerConfigs.keys()]);

    mockGetModel.mockImplementation(((provider: string, modelId: string) => {
      if (modelId === 'ghost-model') return undefined;
      return {
        id: modelId,
        name: modelId,
        provider,
        api: 'mock-api',
        baseUrl: 'https://default.example.com',
      };
    }) as any);

    addAccount('custom-oauth', '');
    storage.set('selected-model', 'custom-oauth:ghost-model');

    // resolveModelById falls through to resolveCurrentModel which finds the custom model
    const model = resolveModelById('ghost-model');
    expect(model.id).toBe('ghost-model');
    expect(model.provider).toBe('custom-oauth');
  });
});

describe('fallback model fields', () => {
  beforeEach(() => {
    storage.clear();
    vi.clearAllMocks();
  });

  it('fallback model from getModelIds has required pi-ai fields', () => {
    const providerConfigs = new Map(
      mockGetRegisteredProviderIds().map((id: string) => [id, mockGetRegisteredProviderConfig(id)])
    );
    providerConfigs.set('custom-oauth', {
      id: 'custom-oauth',
      name: 'Custom OAuth',
      description: 'Test',
      requiresApiKey: false,
      requiresBaseUrl: false,
      isOAuth: true,
      getModelIds: () => [{ id: 'unknown-model', name: 'Unknown' }],
    });
    mockGetRegisteredProviderConfig.mockImplementation((id: string) => providerConfigs.get(id));

    const models = getProviderModels('custom-oauth');
    const model = models[0] as any;

    // These fields are required by pi-ai's streamAnthropic
    expect(model.baseUrl).toBe('');
    expect(model.input).toEqual(['text', 'image']);
    expect(model.contextWindow).toBe(200000);
    expect(model.maxTokens).toBe(16384);
    expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(model.reasoning).toBe(true);
  });
});

describe('getProviderModels with getModelIds', () => {
  beforeEach(() => {
    storage.clear();
    vi.clearAllMocks();
  });

  it('uses getModelIds when provider defines it', () => {
    // Register a provider with getModelIds
    const providerConfigs = new Map(
      mockGetRegisteredProviderIds().map((id: string) => [id, mockGetRegisteredProviderConfig(id)])
    );
    providerConfigs.set('custom-oauth', {
      id: 'custom-oauth',
      name: 'Custom OAuth',
      description: 'Test',
      requiresApiKey: false,
      requiresBaseUrl: false,
      isOAuth: true,
      getModelIds: () => [{ id: 'claude-sonnet-4-0', name: 'Claude Sonnet 4' }],
    });
    mockGetRegisteredProviderConfig.mockImplementation((id: string) => providerConfigs.get(id));

    const models = getProviderModels('custom-oauth');
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('claude-sonnet-4-0');
    expect(models[0].provider).toBe('custom-oauth');
    expect(models[0].api).toBe('custom-oauth-anthropic');
  });

  it('falls back to all anthropic models for OAuth without getModelIds', () => {
    const models = getProviderModels('test-oauth');
    expect(models).toHaveLength(1); // mockGetModels returns 1 anthropic model
    expect(models[0].id).toBe('claude-sonnet-4-0');
    expect(models[0].api).toBe('test-oauth-anthropic');
  });

  it('returns empty array and logs error when getModelIds throws', () => {
    const providerConfigs = new Map(
      mockGetRegisteredProviderIds().map((id: string) => [id, mockGetRegisteredProviderConfig(id)])
    );
    providerConfigs.set('broken-oauth', {
      id: 'broken-oauth',
      name: 'Broken OAuth',
      description: 'Test',
      requiresApiKey: false,
      requiresBaseUrl: false,
      isOAuth: true,
      getModelIds: () => {
        throw new Error('config fetch failed');
      },
    });
    mockGetRegisteredProviderConfig.mockImplementation((id: string) => providerConfigs.get(id));

    const models = getProviderModels('broken-oauth');
    expect(models).toEqual([]);
    expect(mockLog.error).toHaveBeenCalledWith(
      'Provider getModelIds callback failed',
      expect.objectContaining({ providerId: 'broken-oauth' })
    );
  });

  it('creates fallback model for unknown model IDs from getModelIds', () => {
    const providerConfigs = new Map(
      mockGetRegisteredProviderIds().map((id: string) => [id, mockGetRegisteredProviderConfig(id)])
    );
    providerConfigs.set('custom-oauth', {
      id: 'custom-oauth',
      name: 'Custom OAuth',
      description: 'Test',
      requiresApiKey: false,
      requiresBaseUrl: false,
      isOAuth: true,
      getModelIds: () => [{ id: 'unknown-model-id', name: 'My Custom Model' }],
    });
    mockGetRegisteredProviderConfig.mockImplementation((id: string) => providerConfigs.get(id));

    const models = getProviderModels('custom-oauth');
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('unknown-model-id');
    expect(models[0].name).toBe('My Custom Model');
    expect(models[0].provider).toBe('custom-oauth');
  });
});

describe('Adobe sonnet model preference', () => {
  function setupAdobeProvider(modelIds: Array<{ id: string; name: string; api?: string }>) {
    const providerConfigs = new Map(
      mockGetRegisteredProviderIds().map((id: string) => [id, mockGetRegisteredProviderConfig(id)])
    );
    providerConfigs.set('adobe', {
      id: 'adobe',
      name: 'Adobe',
      description: 'Adobe provider',
      requiresApiKey: false,
      requiresBaseUrl: false,
      isOAuth: true,
      defaultModelId: 'sonnet',
      getModelIds: () => modelIds,
    });
    mockGetRegisteredProviderConfig.mockImplementation((id: string) => providerConfigs.get(id));
    mockGetRegisteredProviderIds.mockReturnValue([...providerConfigs.keys()]);
    saveOAuthAccount({ providerId: 'adobe', accessToken: 'tok-test' });
  }

  beforeEach(() => {
    storage.clear();
    vi.clearAllMocks();
    mockGetProviders.mockReturnValue(['anthropic']);
    mockGetModels.mockImplementation((providerId: string) => {
      if (providerId === 'anthropic') {
        return [
          { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', reasoning: true },
          { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', reasoning: true },
        ];
      }
      return [];
    });
  });

  it('resolveCurrentModel prefers sonnet for Adobe when no model selected', () => {
    setupAdobeProvider([
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
    ]);
    storage.set('selected-model', 'adobe:');
    const model = resolveCurrentModel();
    expect(model.id).toBe('claude-sonnet-4-6');
  });

  it('resolveCurrentModel respects explicit selection over sonnet preference', () => {
    setupAdobeProvider([
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
    ]);
    storage.set('selected-model', 'adobe:claude-opus-4-6');
    const model = resolveCurrentModel();
    expect(model.id).toBe('claude-opus-4-6');
  });

  it('resolveCurrentModel falls back to first model when no sonnet available', () => {
    setupAdobeProvider([
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
      { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
    ]);
    storage.set('selected-model', 'adobe:');
    const model = resolveCurrentModel();
    expect(model.id).toBe('claude-opus-4-6');
  });

  it('does NOT apply defaultModelId preference for providers without it', () => {
    addAccount('anthropic', 'ant-key');
    // No selected-model — anthropic has no defaultModelId, so picks first model
    const model = resolveCurrentModel();
    expect(model.id).toBe('claude-opus-4-6');
  });
});

describe('model metadata overrides', () => {
  beforeEach(() => {
    storage.clear();
    mockGetProviders.mockReturnValue(['anthropic']);
    mockGetModels.mockImplementation((providerId: string) => {
      if (providerId === 'anthropic') {
        return [
          {
            id: 'claude-opus-4-6',
            name: 'Claude Opus 4.6',
            contextWindow: 200000,
            maxTokens: 16384,
            reasoning: true,
          },
          {
            id: 'claude-sonnet-4-6',
            name: 'Claude Sonnet 4.6',
            contextWindow: 200000,
            maxTokens: 16384,
            reasoning: true,
          },
        ];
      }
      return [];
    });
  });

  it('getModelIds metadata overrides pi-ai defaults for known models', () => {
    const providerConfigs = new Map(
      mockGetRegisteredProviderIds().map((id: string) => [id, mockGetRegisteredProviderConfig(id)])
    );
    providerConfigs.set('test-proxy', {
      id: 'test-proxy',
      name: 'Test Proxy',
      description: '',
      requiresApiKey: false,
      requiresBaseUrl: false,
      getModelIds: () => [
        {
          id: 'claude-opus-4-6',
          name: 'Claude Opus 4.6',
          context_window: 1000000,
          max_tokens: 128000,
        },
      ],
    });
    mockGetRegisteredProviderConfig.mockImplementation((id: string) => providerConfigs.get(id));

    const models = getProviderModels('test-proxy');
    expect(models).toHaveLength(1);
    expect(models[0].contextWindow).toBe(1000000);
    expect((models[0] as any).maxTokens).toBe(128000);
  });

  it('getModelIds metadata creates correct model for unknown IDs with api field', () => {
    const providerConfigs = new Map(
      mockGetRegisteredProviderIds().map((id: string) => [id, mockGetRegisteredProviderConfig(id)])
    );
    providerConfigs.set('test-proxy', {
      id: 'test-proxy',
      name: 'Test Proxy',
      description: '',
      requiresApiKey: false,
      requiresBaseUrl: false,
      getModelIds: () => [
        {
          id: 'zai-glm-4.7',
          name: 'GLM 4.7',
          api: 'openai',
          context_window: 131072,
          max_tokens: 40960,
          reasoning: true,
          input: ['text'],
        },
      ],
    });
    mockGetRegisteredProviderConfig.mockImplementation((id: string) => providerConfigs.get(id));

    const models = getProviderModels('test-proxy');
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('zai-glm-4.7');
    expect(models[0].contextWindow).toBe(131072);
    expect((models[0] as any).maxTokens).toBe(40960);
    expect(models[0].reasoning).toBe(true);
  });

  it('api field determines model.api for stream routing', () => {
    const providerConfigs = new Map(
      mockGetRegisteredProviderIds().map((id: string) => [id, mockGetRegisteredProviderConfig(id)])
    );
    providerConfigs.set('test-proxy', {
      id: 'test-proxy',
      name: 'Test Proxy',
      description: '',
      requiresApiKey: false,
      requiresBaseUrl: false,
      getModelIds: () => [
        { id: 'zai-glm-4.7', name: 'GLM 4.7', api: 'openai' },
        { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
      ],
    });
    mockGetRegisteredProviderConfig.mockImplementation((id: string) => providerConfigs.get(id));

    const models = getProviderModels('test-proxy');
    const glm = models.find((m) => m.id === 'zai-glm-4.7')!;
    const opus = models.find((m) => m.id === 'claude-opus-4-6')!;
    expect(String(glm.api)).toContain('openai');
    expect(String(opus.api)).toContain('anthropic');
  });

  it('modelOverrides applies to OAuth provider models', () => {
    const providerConfigs = new Map(
      mockGetRegisteredProviderIds().map((id: string) => [id, mockGetRegisteredProviderConfig(id)])
    );
    providerConfigs.set('custom-oauth', {
      id: 'custom-oauth',
      name: 'Custom OAuth',
      description: '',
      requiresApiKey: false,
      requiresBaseUrl: false,
      isOAuth: true,
      modelOverrides: {
        'claude-opus-4-6': { context_window: 500000 },
      },
    });
    mockGetRegisteredProviderConfig.mockImplementation((id: string) => providerConfigs.get(id));

    const models = getProviderModels('custom-oauth');
    const opus = models.find((m) => m.id === 'claude-opus-4-6');
    expect(opus).toBeDefined();
    expect(opus!.contextWindow).toBe(500000);
    // Unaffected model keeps defaults
    const sonnet = models.find((m) => m.id === 'claude-sonnet-4-6');
    expect(sonnet!.contextWindow).toBe(200000);
  });

  it('getModelIds metadata takes priority over modelOverrides', () => {
    const providerConfigs = new Map(
      mockGetRegisteredProviderIds().map((id: string) => [id, mockGetRegisteredProviderConfig(id)])
    );
    providerConfigs.set('test-proxy', {
      id: 'test-proxy',
      name: 'Test Proxy',
      description: '',
      requiresApiKey: false,
      requiresBaseUrl: false,
      modelOverrides: {
        'claude-opus-4-6': { context_window: 500000 },
      },
      getModelIds: () => [
        { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', context_window: 1000000 },
      ],
    });
    mockGetRegisteredProviderConfig.mockImplementation((id: string) => providerConfigs.get(id));

    const models = getProviderModels('test-proxy');
    // getModelIds (layer 3) wins over modelOverrides (layer 2)
    expect(models[0].contextWindow).toBe(1000000);
  });

  it('models without api field default to anthropic routing', () => {
    const providerConfigs = new Map(
      mockGetRegisteredProviderIds().map((id: string) => [id, mockGetRegisteredProviderConfig(id)])
    );
    providerConfigs.set('test-proxy', {
      id: 'test-proxy',
      name: 'Test Proxy',
      description: '',
      requiresApiKey: false,
      requiresBaseUrl: false,
      getModelIds: () => [{ id: 'claude-opus-4-6', name: 'Claude Opus 4.6' }],
    });
    mockGetRegisteredProviderConfig.mockImplementation((id: string) => providerConfigs.get(id));

    const models = getProviderModels('test-proxy');
    expect(String(models[0].api)).toContain('anthropic');
    expect(String(models[0].api)).not.toContain('openai');
  });
});
