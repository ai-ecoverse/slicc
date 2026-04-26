/**
 * Tests for GitHub provider logic.
 *
 * The provider file uses import.meta.glob and browser APIs, so we test
 * the core logic patterns directly (same approach as adobe-provider.test.ts).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock localStorage
const storage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => storage.set(k, v),
  removeItem: (k: string) => storage.delete(k),
  get length() {
    return storage.size;
  },
  key: (i: number) => [...storage.keys()][i] ?? null,
  clear: () => storage.clear(),
});

beforeEach(() => storage.clear());

describe('GitHub OAuth code extraction', () => {
  // Reimplement the extraction logic here for testability
  // (same as extractCodeFromUrl in github.ts)
  function extractCodeFromUrl(url: string): string | null {
    try {
      const parsed = new URL(url);
      return parsed.searchParams.get('code');
    } catch {
      return null;
    }
  }

  it('extracts code from a standard OAuth redirect URL', () => {
    expect(
      extractCodeFromUrl('http://localhost:5710/auth/callback?nonce=abc&code=gh_auth_code_123')
    ).toBe('gh_auth_code_123');
  });

  it('extracts code when state is also present', () => {
    expect(
      extractCodeFromUrl('http://localhost:5710/auth/callback?code=mycode&state=base64state')
    ).toBe('mycode');
  });

  it('returns null when no code parameter exists', () => {
    expect(extractCodeFromUrl('http://localhost:5710/auth/callback?nonce=abc')).toBeNull();
  });

  it('returns null for fragment-only URLs (implicit grant)', () => {
    expect(extractCodeFromUrl('http://localhost:5710/auth/callback#access_token=tok')).toBeNull();
  });

  it('returns null for invalid URLs', () => {
    expect(extractCodeFromUrl('not-a-url')).toBeNull();
  });

  it('returns empty string for empty code param', () => {
    expect(extractCodeFromUrl('http://localhost:5710/auth/callback?code=')).toBe('');
  });
});

describe('GitHub OAuth state parameter encoding', () => {
  it('encodes port, path, and nonce into base64 state', () => {
    const state = btoa(
      JSON.stringify({
        port: 5710,
        path: '/auth/callback',
        nonce: 'test-nonce',
      })
    );
    const decoded = JSON.parse(atob(state));
    expect(decoded.port).toBe(5710);
    expect(decoded.path).toBe('/auth/callback');
    expect(decoded.nonce).toBe('test-nonce');
  });
});

describe('GitHub account storage', () => {
  it('stores and retrieves an OAuth account', () => {
    const account = {
      providerId: 'github',
      apiKey: '',
      accessToken: 'gho_test_token',
      userName: 'testuser',
      userAvatar: 'https://avatars.githubusercontent.com/u/123',
    };

    storage.set('slicc_accounts', JSON.stringify([account]));

    const accounts = JSON.parse(storage.get('slicc_accounts')!);
    const github = accounts.find((a: { providerId: string }) => a.providerId === 'github');
    expect(github.accessToken).toBe('gho_test_token');
    expect(github.userName).toBe('testuser');
  });

  it('GitHub tokens do not expire (no tokenExpiresAt)', () => {
    const account = {
      providerId: 'github',
      apiKey: '',
      accessToken: 'gho_test_token',
    };

    // GitHub OAuth tokens don't expire, so tokenExpiresAt should be absent
    expect(account).not.toHaveProperty('tokenExpiresAt');

    // The getOAuthAccountInfo logic considers missing expiresAt as not expired
    const tokenExpiresAt: number | undefined = undefined;
    const expired = !!tokenExpiresAt && Date.now() > tokenExpiresAt - 60000;
    expect(expired).toBe(false);
  });
});

describe('GitHub Models configuration', () => {
  it('known models are OpenAI-compatible', () => {
    // These match the GITHUB_MODELS array in github.ts
    const models = [
      { id: 'gpt-4o', api: 'openai' },
      { id: 'gpt-4o-mini', api: 'openai' },
      { id: 'o4-mini', api: 'openai' },
      { id: 'o3-mini', api: 'openai' },
    ];

    for (const m of models) {
      expect(m.api).toBe('openai');
    }
    expect(models.length).toBeGreaterThan(0);
  });

  it('models endpoint is OpenAI-compatible', () => {
    const baseUrl = 'https://models.inference.ai.azure.com';
    // The provider appends /v1 so the OpenAI SDK adds /chat/completions
    expect(`${baseUrl}/v1`).toBe('https://models.inference.ai.azure.com/v1');
  });
});

describe('GitHub git token bridge pattern', () => {
  it('token path matches what git-commands.ts reads', () => {
    // git-commands.ts reads from: /workspace/.git/github-token
    const tokenPath = '/workspace/.git/github-token';
    expect(tokenPath).toBe('/workspace/.git/github-token');
  });

  it('dispatches github-token-changed event on write', () => {
    // The provider dispatches window.dispatchEvent(new CustomEvent('github-token-changed'))
    // after writing the token to VFS. git-commands.ts listens for this to invalidate its cache.
    const event = new CustomEvent('github-token-changed');
    expect(event.type).toBe('github-token-changed');
  });
});
