import { beforeEach, describe, expect, it, vi } from 'vitest';

let launchWebAuthFlow: ReturnType<typeof vi.fn>;

async function loadModule(): Promise<typeof import('../src/oauth-sw.js')> {
  vi.resetModules();
  return import('../src/oauth-sw.js');
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    type: 'oauth-request' as const,
    providerId: 'adobe',
    authorizeUrl: 'https://ims.example.com/authorize',
    ...overrides,
  };
}

beforeEach(() => {
  launchWebAuthFlow = vi.fn();
  (globalThis as typeof globalThis & { chrome: unknown }).chrome = {
    identity: { launchWebAuthFlow, getRedirectURL: vi.fn(() => 'https://ext.example/cb') },
  };
});

describe('handleOAuthRequest', () => {
  it('returns the code and state from the redirect query string', async () => {
    const { handleOAuthRequest } = await loadModule();
    const redirectUrl = 'https://ext.example/cb?code=abc123&state=xyz';
    launchWebAuthFlow.mockResolvedValue(redirectUrl);

    await expect(handleOAuthRequest(request() as never)).resolves.toEqual({
      type: 'oauth-result',
      providerId: 'adobe',
      code: 'abc123',
      state: 'xyz',
      redirectUrl,
    });
  });

  it('reports a cancelled flow rather than throwing on an absent redirect URL', async () => {
    const { handleOAuthRequest } = await loadModule();
    launchWebAuthFlow.mockResolvedValue(undefined);

    await expect(handleOAuthRequest(request() as never)).resolves.toEqual({
      type: 'oauth-result',
      providerId: 'adobe',
      error: 'OAuth flow was cancelled or returned no URL',
    });
  });

  it('prefers error_description over the raw error code', async () => {
    const { handleOAuthRequest } = await loadModule();
    launchWebAuthFlow.mockResolvedValue(
      'https://ext.example/cb?error=access_denied&error_description=User%20said%20no'
    );

    await expect(handleOAuthRequest(request() as never)).resolves.toEqual({
      type: 'oauth-result',
      providerId: 'adobe',
      error: 'User said no',
    });
  });

  it('surfaces an error reported in the hash fragment (implicit-flow providers)', async () => {
    const { handleOAuthRequest } = await loadModule();
    launchWebAuthFlow.mockResolvedValue('https://ext.example/cb#error=invalid_scope');

    await expect(handleOAuthRequest(request() as never)).resolves.toEqual({
      type: 'oauth-result',
      providerId: 'adobe',
      error: 'invalid_scope',
    });
  });

  it('leaves code/state undefined when the provider returns neither', async () => {
    const { handleOAuthRequest } = await loadModule();
    const redirectUrl = 'https://ext.example/cb';
    launchWebAuthFlow.mockResolvedValue(redirectUrl);

    await expect(handleOAuthRequest(request() as never)).resolves.toEqual({
      type: 'oauth-result',
      providerId: 'adobe',
      code: undefined,
      state: undefined,
      redirectUrl,
    });
  });
});
