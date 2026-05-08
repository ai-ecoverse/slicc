/**
 * Tests for the optionalApiKey ProviderConfig flag.
 *
 * Local LLM servers (Ollama, LM Studio, llama.cpp) ignore the API key but
 * the scoop init guard and pi-ai's openai-completions stream both reject
 * a null key. `optionalApiKey: true` makes getApiKeyForProvider fall back
 * to a placeholder so those gates pass while still letting users paste a
 * real key for hosted OpenAI-compatible endpoints.
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

const { mockCreateLogger } = vi.hoisted(() => {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { mockCreateLogger: vi.fn(() => log) };
});

vi.mock('../../src/core/index.js', () => ({
  getProviders: vi.fn(() => []),
  getModels: vi.fn(() => []),
  getModel: vi.fn(),
  createLogger: mockCreateLogger,
}));

const { providerConfigs } = vi.hoisted(() => ({
  providerConfigs: new Map<string, Record<string, unknown>>([
    [
      'optional-key-provider',
      {
        id: 'optional-key-provider',
        name: 'Optional Key',
        description: '',
        requiresApiKey: false,
        optionalApiKey: true,
        requiresBaseUrl: true,
      },
    ],
    [
      'strict-key-provider',
      {
        id: 'strict-key-provider',
        name: 'Strict Key',
        description: '',
        requiresApiKey: true,
        requiresBaseUrl: false,
      },
    ],
  ]),
}));

vi.mock('../../src/providers/index.js', () => ({
  getRegisteredProviderConfig: vi.fn((id: string) => providerConfigs.get(id)),
  getRegisteredProviderIds: vi.fn(() => [...providerConfigs.keys()]),
  shouldIncludeProvider: () => true,
}));

import {
  addAccount,
  getAccounts,
  getApiKeyForProvider,
  getRawApiKeyForProvider,
  setBaseUrl,
} from '../../src/ui/provider-settings.js';

describe('optionalApiKey fallback', () => {
  beforeEach(() => {
    storage.clear();
    vi.clearAllMocks();
  });

  it('returns the "local" placeholder when optionalApiKey is set and no key is stored', () => {
    addAccount('optional-key-provider', '', 'http://localhost:11434/v1');
    expect(getApiKeyForProvider('optional-key-provider')).toBe('local');
  });

  it('returns the user-supplied key when one is set, even with optionalApiKey', () => {
    // Hosted OpenAI-compat endpoints (Together, Anyscale, Fireworks) need a real key.
    addAccount('optional-key-provider', 'real-token', 'https://api.together.xyz/v1');
    expect(getApiKeyForProvider('optional-key-provider')).toBe('real-token');
  });

  it('returns null when optionalApiKey is not set and no key is stored', () => {
    addAccount('strict-key-provider', '');
    expect(getApiKeyForProvider('strict-key-provider')).toBeNull();
  });

  it('returns null when no account exists for the provider at all', () => {
    expect(getApiKeyForProvider('optional-key-provider')).toBeNull();
  });
});

describe('getRawApiKeyForProvider', () => {
  beforeEach(() => {
    storage.clear();
    vi.clearAllMocks();
  });

  it('returns null when account exists but apiKey is empty (no placeholder injection)', () => {
    addAccount('optional-key-provider', '', 'http://localhost:11434/v1');
    expect(getRawApiKeyForProvider('optional-key-provider')).toBeNull();
  });

  it('returns the user-supplied key when one is set', () => {
    addAccount('optional-key-provider', 'real-token', 'https://api.together.xyz/v1');
    expect(getRawApiKeyForProvider('optional-key-provider')).toBe('real-token');
  });

  it('returns null when no account exists', () => {
    expect(getRawApiKeyForProvider('optional-key-provider')).toBeNull();
  });
});

describe('setBaseUrl does not persist the optionalApiKey placeholder (regression)', () => {
  beforeEach(() => {
    storage.clear();
    vi.clearAllMocks();
  });

  it('skips the addAccount upsert when no real key is stored', () => {
    // The previous bug: getApiKeyForProvider would resolve to 'local' for
    // optional-key providers, setBaseUrl's `if (apiKey)` branch would fire,
    // and addAccount(provider, 'local', url) would write 'local' as the
    // durable apiKey — shadowing the placeholder fallback on every later read.
    addAccount('optional-key-provider', '', 'http://localhost:11434/v1');
    storage.set('selected-model', 'optional-key-provider:any-model');

    setBaseUrl('http://localhost:8080/v1');

    // The account should still have an empty apiKey — not 'local'.
    const account = getAccounts().find((a) => a.providerId === 'optional-key-provider');
    expect(account?.apiKey).toBe('');
  });

  it('still updates baseUrl when a real key is stored', () => {
    addAccount('optional-key-provider', 'real-token', 'http://localhost:11434/v1');
    storage.set('selected-model', 'optional-key-provider:any-model');

    setBaseUrl('https://api.together.xyz/v1');

    const account = getAccounts().find((a) => a.providerId === 'optional-key-provider');
    expect(account?.apiKey).toBe('real-token');
    expect(account?.baseUrl).toBe('https://api.together.xyz/v1');
  });
});
