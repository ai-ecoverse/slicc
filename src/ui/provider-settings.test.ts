/**
 * Tests for provider settings storage + migration behavior.
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
} from './provider-settings.js';

describe('provider settings storage', () => {
  beforeEach(() => {
    storage.clear();
    vi.clearAllMocks();
  });

  it('defaults provider to anthropic', () => {
    expect(getSelectedProvider()).toBe('anthropic');
  });

  it('prefers stored provider over legacy provider', () => {
    storage.set('slicc_provider', 'openai');
    storage.set('api_provider', 'bedrock');
    expect(getSelectedProvider()).toBe('openai');
  });

  it('maps legacy azure provider to azure-ai-foundry', () => {
    storage.set('api_provider', 'azure');
    expect(getSelectedProvider()).toBe('azure-ai-foundry');
  });

  it('maps legacy bedrock provider to amazon-bedrock', () => {
    storage.set('api_provider', 'bedrock');
    expect(getSelectedProvider()).toBe('amazon-bedrock');
  });

  it('reads api key from new storage first, then legacy', () => {
    storage.set('anthropic_api_key', 'legacy-key');
    expect(getApiKey()).toBe('legacy-key');

    setApiKey('new-key');
    expect(getApiKey()).toBe('new-key');
  });

  it('clears new and legacy api keys', () => {
    storage.set('anthropic_api_key', 'legacy-key');
    setApiKey('new-key');
    clearApiKey();
    expect(getApiKey()).toBeNull();
  });

  it('migrates legacy azure resource to foundry endpoint when using legacy azure provider', () => {
    storage.set('api_provider', 'azure');
    storage.set('azure_resource', 'my-resource');
    expect(getBaseUrl()).toBe('https://my-resource.services.ai.azure.com/anthropic');
  });

  it('preserves full legacy azure URL as-is', () => {
    storage.set('api_provider', 'azure');
    storage.set('azure_resource', 'https://contoso.services.ai.azure.com/anthropic');
    expect(getBaseUrl()).toBe('https://contoso.services.ai.azure.com/anthropic');
  });

  it('normalizes legacy bedrock endpoint to include https scheme', () => {
    storage.set('api_provider', 'bedrock');
    storage.set('bedrock_region', 'us-east-1');
    expect(getBaseUrl()).toBe('https://us-east-1');
  });

  it('keeps legacy bedrock endpoint unchanged when already absolute URL', () => {
    storage.set('api_provider', 'bedrock');
    storage.set('bedrock_region', 'https://bedrock-runtime.us-east-1.amazonaws.com');
    expect(getBaseUrl()).toBe('https://bedrock-runtime.us-east-1.amazonaws.com');
  });

  it('stores and clears provider/model/baseUrl keys', () => {
    setSelectedProvider('openai');
    setSelectedModelId('gpt-5');
    setBaseUrl('https://proxy.example.com');

    expect(getSelectedProvider()).toBe('openai');
    expect(getSelectedModelId()).toBe('gpt-5');
    expect(getBaseUrl()).toBe('https://proxy.example.com');

    clearBaseUrl();
    expect(getBaseUrl()).toBeNull();

    clearSelectedProvider();
    expect(getSelectedProvider()).toBe('anthropic');
  });

  it('clears all modern and legacy keys', () => {
    const keys = [
      'slicc_provider',
      'slicc_api_key',
      'slicc_base_url',
      'selected-model',
      'anthropic_api_key',
      'api_provider',
      'azure_resource',
      'bedrock_region',
    ];
    for (const key of keys) storage.set(key, 'value');

    clearAllSettings();

    for (const key of keys) {
      expect(storage.get(key)).toBeUndefined();
    }
  });
});

describe('resolveCurrentModel', () => {
  beforeEach(() => {
    storage.clear();
    vi.clearAllMocks();
  });

  it('resolves selected provider/model and applies baseUrl override', () => {
    setSelectedProvider('openai');
    setSelectedModelId('gpt-5');
    setBaseUrl('https://proxy.example.com');

    const model = resolveCurrentModel();

    expect(mockGetModel).toHaveBeenCalledWith('openai', 'gpt-5');
    expect(model.id).toBe('gpt-5');
    expect((model as any).baseUrl).toBe('https://proxy.example.com');
  });

  it('falls back to anthropic default model when model lookup fails', () => {
    mockGetModel.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    setSelectedProvider('openai');
    setSelectedModelId('gpt-5');

    const model = resolveCurrentModel();

    expect(mockGetModel).toHaveBeenNthCalledWith(2, 'anthropic', 'claude-sonnet-4-20250514');
    expect((model as any).provider).toBe('anthropic');
    expect(model.id).toBe('claude-sonnet-4-20250514');
  });
});
