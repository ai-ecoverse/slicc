/**
 * Tests for provider auto-discovery and build-time filtering.
 *
 * These tests verify the filtering logic in isolation, since import.meta.glob
 * resolution happens at build time (Vite), not in Vitest's Node runtime.
 */

import { describe, it, expect } from 'vitest';
import type { ProviderConfig } from '../../src/providers/types.js';

// ── Test the filtering logic directly ──────────────────────────────

interface BuildConfig {
  include: string[];
  exclude: string[];
}

function shouldIncludeBuiltIn(providerId: string, buildConfig: BuildConfig): boolean {
  const { include, exclude } = buildConfig;
  if (exclude.includes('*') || exclude.includes(providerId)) return false;
  if (include.includes('*')) return true;
  if (include.includes(providerId)) return true;
  return false;
}

function filterProviders(providers: ProviderConfig[], buildConfig: BuildConfig): ProviderConfig[] {
  return providers.filter((p) => shouldIncludeBuiltIn(p.id, buildConfig));
}

const ALL_PROVIDERS: ProviderConfig[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    description: '',
    requiresApiKey: true,
    requiresBaseUrl: false,
  },
  { id: 'openai', name: 'OpenAI', description: '', requiresApiKey: true, requiresBaseUrl: false },
  { id: 'groq', name: 'Groq', description: '', requiresApiKey: true, requiresBaseUrl: false },
  {
    id: 'bedrock-camp',
    name: 'Bedrock CAMP',
    description: '',
    requiresApiKey: true,
    requiresBaseUrl: true,
  },
  {
    id: 'huggingface',
    name: 'HuggingFace',
    description: '',
    requiresApiKey: true,
    requiresBaseUrl: false,
  },
];

describe('provider build-time filtering', () => {
  it('include: ["*"] includes all providers', () => {
    const result = filterProviders(ALL_PROVIDERS, { include: ['*'], exclude: [] });
    expect(result).toHaveLength(5);
  });

  it('include: ["*"] with exclude: ["groq"] excludes groq', () => {
    const result = filterProviders(ALL_PROVIDERS, { include: ['*'], exclude: ['groq'] });
    expect(result).toHaveLength(4);
    expect(result.find((p) => p.id === 'groq')).toBeUndefined();
  });

  it('include: ["anthropic", "openai"] includes only those two', () => {
    const result = filterProviders(ALL_PROVIDERS, {
      include: ['anthropic', 'openai'],
      exclude: [],
    });
    expect(result).toHaveLength(2);
    expect(result.map((p) => p.id)).toEqual(['anthropic', 'openai']);
  });

  it('exclude: ["*"] excludes everything', () => {
    const result = filterProviders(ALL_PROVIDERS, { include: ['*'], exclude: ['*'] });
    expect(result).toHaveLength(0);
  });

  it('include: [] with exclude: ["*"] excludes all (custom-only build)', () => {
    const result = filterProviders(ALL_PROVIDERS, { include: [], exclude: ['*'] });
    expect(result).toHaveLength(0);
  });

  it('include: [] with no exclude includes nothing (empty build)', () => {
    const result = filterProviders(ALL_PROVIDERS, { include: [], exclude: [] });
    expect(result).toHaveLength(0);
  });

  it('exclude specific providers from wildcard include', () => {
    const result = filterProviders(ALL_PROVIDERS, {
      include: ['*'],
      exclude: ['bedrock-camp', 'huggingface'],
    });
    expect(result).toHaveLength(3);
    expect(result.find((p) => p.id === 'bedrock-camp')).toBeUndefined();
    expect(result.find((p) => p.id === 'huggingface')).toBeUndefined();
  });
});

describe('provider config shape', () => {
  it('ProviderConfig supports isOAuth field', () => {
    const oauthProvider: ProviderConfig = {
      id: 'my-oauth',
      name: 'My OAuth',
      description: 'OAuth provider',
      requiresApiKey: false,
      requiresBaseUrl: false,
      isOAuth: true,
    };
    expect(oauthProvider.isOAuth).toBe(true);
    expect(oauthProvider.requiresApiKey).toBe(false);
  });

  it('ProviderConfig supports onOAuthLogin and onOAuthLogout callbacks', () => {
    const loginFn = async (
      _launcher: (url: string) => Promise<string | null>,
      _onSuccess: () => void
    ) => {};
    const logoutFn = async () => {};

    const oauthProvider: ProviderConfig = {
      id: 'my-oauth',
      name: 'My OAuth',
      description: 'OAuth provider with callbacks',
      requiresApiKey: false,
      requiresBaseUrl: false,
      isOAuth: true,
      onOAuthLogin: loginFn,
      onOAuthLogout: logoutFn,
    };
    expect(oauthProvider.onOAuthLogin).toBe(loginFn);
    expect(oauthProvider.onOAuthLogout).toBe(logoutFn);
  });

  it('onOAuthLogin receives launcher and calls it with authorize URL', async () => {
    const mockLauncher = async (url: string) => `${url}#access_token=test123`;
    let successCalled = false;

    const provider: ProviderConfig = {
      id: 'test-corp',
      name: 'Test Corp',
      description: '',
      requiresApiKey: false,
      requiresBaseUrl: false,
      isOAuth: true,
      onOAuthLogin: async (launcher, onSuccess) => {
        const redirectUrl = await launcher('https://sso.example.com/authorize');
        if (redirectUrl?.includes('access_token=')) {
          onSuccess();
        }
      },
    };

    await provider.onOAuthLogin!(mockLauncher, () => {
      successCalled = true;
    });
    expect(successCalled).toBe(true);
  });

  it('onOAuthLogin handles null from launcher (user cancelled)', async () => {
    const mockLauncher = async () => null;
    let successCalled = false;

    const provider: ProviderConfig = {
      id: 'test-corp',
      name: 'Test Corp',
      description: '',
      requiresApiKey: false,
      requiresBaseUrl: false,
      isOAuth: true,
      onOAuthLogin: async (launcher, onSuccess) => {
        const redirectUrl = await launcher('https://sso.example.com/authorize');
        if (!redirectUrl) return;
        onSuccess();
      },
    };

    await provider.onOAuthLogin!(mockLauncher, () => {
      successCalled = true;
    });
    expect(successCalled).toBe(false);
  });
});

describe('provider config model metadata', () => {
  it('ProviderConfig supports modelOverrides field', () => {
    const config: ProviderConfig = {
      id: 'test-provider',
      name: 'Test',
      description: '',
      requiresApiKey: true,
      requiresBaseUrl: false,
      modelOverrides: {
        'claude-opus-4-6': { context_window: 1000000, max_tokens: 32768 },
        'zai-glm-4.7': { api: 'openai', context_window: 131072, reasoning: true },
      },
    };
    expect(config.modelOverrides?.['claude-opus-4-6']?.context_window).toBe(1000000);
    expect(config.modelOverrides?.['zai-glm-4.7']?.api).toBe('openai');
  });

  it('getModelIds supports metadata fields', () => {
    const config: ProviderConfig = {
      id: 'test-provider',
      name: 'Test',
      description: '',
      requiresApiKey: false,
      requiresBaseUrl: false,
      getModelIds: () => [
        { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', context_window: 1000000 },
        {
          id: 'zai-glm-4.7',
          name: 'GLM 4.7',
          api: 'openai' as const,
          context_window: 131072,
          max_tokens: 40960,
          reasoning: true,
          input: ['text'],
        },
      ],
    };
    const models = config.getModelIds!();
    expect(models[0].context_window).toBe(1000000);
    expect(models[1].api).toBe('openai');
    expect(models[1].input).toEqual(['text']);
  });
});
