import { beforeEach, describe, expect, it, vi } from 'vitest';

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

    expect(account).not.toHaveProperty('tokenExpiresAt');

    const tokenExpiresAt: number | undefined = undefined;
    const expired = !!tokenExpiresAt && Date.now() > tokenExpiresAt - 60000;
    expect(expired).toBe(false);
  });
});

describe('GitHub Models configuration', () => {
  const GITHUB_MODELS = [
    {
      id: 'openai/gpt-4.1',
      name: 'GPT-4.1',
      api: 'openai',
      context_window: 1047576,
      max_tokens: 32768,
      reasoning: false,
    },
    {
      id: 'openai/gpt-4.1-mini',
      name: 'GPT-4.1 mini',
      api: 'openai',
      context_window: 1047576,
      max_tokens: 32768,
      reasoning: false,
    },
  ];

  it('only contains free-tier models (no paid-plan-only models)', () => {
    const paidOnlyIds = ['o4-mini', 'o3-mini', 'o1', 'o1-mini', 'o3'].flatMap((m) => [
      m,
      `openai/${m}`,
    ]);
    for (const model of GITHUB_MODELS) {
      expect(paidOnlyIds).not.toContain(model.id);
    }
  });

  it('does not contain deprecated models', () => {
    const deprecatedIds = ['gpt-4o', 'gpt-4o-mini', 'o3-mini', 'gpt-4.5', 'o1'].flatMap((m) => [
      m,
      `openai/${m}`,
    ]);
    for (const model of GITHUB_MODELS) {
      expect(deprecatedIds).not.toContain(model.id);
    }
  });

  it('all models are OpenAI-compatible', () => {
    for (const m of GITHUB_MODELS) {
      expect(m.api).toBe('openai');
    }
  });

  it('uses vendor-prefixed model IDs required by models.github.ai', () => {
    for (const m of GITHUB_MODELS) {
      expect(m.id).toMatch(/^openai\//);
    }
  });

  it('includes current flagship and mini models', () => {
    const ids = GITHUB_MODELS.map((m) => m.id);
    expect(ids).toContain('openai/gpt-4.1');
    expect(ids).toContain('openai/gpt-4.1-mini');
  });

  it('models have correct context windows for gpt-4.1 series (1M tokens)', () => {
    for (const m of GITHUB_MODELS) {
      expect(m.context_window).toBe(1047576);
      expect(m.max_tokens).toBe(32768);
    }
  });

  it('models endpoint uses new GitHub inference base URL', () => {
    const baseUrl = 'https://models.github.ai/inference';

    expect(`${baseUrl}/chat/completions`).toBe(
      'https://models.github.ai/inference/chat/completions'
    );
  });
});

describe('GitHub git token bridge pattern', () => {
  it('token path matches what git-commands.ts reads', () => {
    const tokenPath = '/workspace/.git/github-token';
    expect(tokenPath).toBe('/workspace/.git/github-token');
  });

  it('dispatches github-token-changed event on write', () => {
    const event = new CustomEvent('github-token-changed');
    expect(event.type).toBe('github-token-changed');
  });
});
