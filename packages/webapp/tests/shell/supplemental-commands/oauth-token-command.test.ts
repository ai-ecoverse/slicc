import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock modules before importing the command
vi.mock('../../../src/ui/provider-settings.js', () => ({
  getOAuthAccountInfo: vi.fn(),
  getSelectedProvider: vi.fn(),
  getAccounts: vi.fn(() => []),
  saveOAuthAccount: vi.fn(),
}));

vi.mock('../../../src/providers/index.js', () => ({
  getRegisteredProviderConfig: vi.fn(),
  getRegisteredProviderIds: vi.fn(() => []),
}));

vi.mock('../../../src/providers/oauth-service.js', () => ({
  createOAuthLauncher: vi.fn(() => vi.fn()),
  createInterceptingOAuthLauncherForCurrentRuntime: vi.fn(),
}));

import {
  getRegisteredProviderConfig,
  getRegisteredProviderIds,
} from '../../../src/providers/index.js';
import {
  createInterceptingOAuthLauncherForCurrentRuntime,
  createOAuthLauncher,
} from '../../../src/providers/oauth-service.js';
import { createOAuthTokenCommand } from '../../../src/shell/supplemental-commands/oauth-token-command.js';
import {
  getAccounts,
  getOAuthAccountInfo,
  getSelectedProvider,
  saveOAuthAccount,
} from '../../../src/ui/provider-settings.js';
import { mockCommandContext } from '../helpers/mock-command-context.js';

const mockGetOAuthAccountInfo = vi.mocked(getOAuthAccountInfo);
const mockGetSelectedProvider = vi.mocked(getSelectedProvider);
const mockGetRegisteredProviderConfig = vi.mocked(getRegisteredProviderConfig);
const mockGetRegisteredProviderIds = vi.mocked(getRegisteredProviderIds);
const mockGetAccounts = vi.mocked(getAccounts);
const mockSaveOAuthAccount = vi.mocked(saveOAuthAccount);
const mockCreateOAuthLauncher = vi.mocked(createOAuthLauncher);
const mockCreateInterceptingOAuthLauncherForCurrentRuntime = vi.mocked(
  createInterceptingOAuthLauncherForCurrentRuntime
);

const createMockCtx = () => mockCommandContext();

describe('oauth-token command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('has correct name', () => {
    const cmd = createOAuthTokenCommand();
    expect(cmd.name).toBe('oauth-token');
  });

  it('shows help with --help', async () => {
    const cmd = createOAuthTokenCommand();
    const result = await cmd.execute(['--help'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('oauth-token');
    expect(result.stdout).toContain('Usage:');
    expect(result.stdout).toContain('Testing:');
    expect(result.stdout).toContain('--expire');
    expect(result.stdout).toContain('Does not revoke anything upstream');
  });

  it('returns stored valid token immediately', async () => {
    mockGetRegisteredProviderConfig.mockReturnValue({
      id: 'adobe',
      name: 'Adobe',
      description: '',
      requiresApiKey: false,
      requiresBaseUrl: false,
      isOAuth: true,
      onOAuthLogin: vi.fn(),
    });
    mockGetOAuthAccountInfo.mockReturnValue({
      token: 'valid-access-token',
      maskedValue: 'masked-valid-access-token',
      expiresAt: Date.now() + 3600000,
      userName: 'karl',
      expired: false,
    });

    const cmd = createOAuthTokenCommand();
    const result = await cmd.execute(['adobe'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('masked-valid-access-token\n');
  });

  it('triggers login when no token exists, returns new token', async () => {
    const mockOnOAuthLogin = vi.fn(async (_launcher, _onSuccess) => {
      // Simulate login saving a token
      mockGetOAuthAccountInfo.mockReturnValue({
        token: 'new-token-after-login',
        maskedValue: 'masked-new-token-after-login',
        expired: false,
      });
    });

    mockGetRegisteredProviderConfig.mockReturnValue({
      id: 'adobe',
      name: 'Adobe',
      description: '',
      requiresApiKey: false,
      requiresBaseUrl: false,
      isOAuth: true,
      onOAuthLogin: mockOnOAuthLogin,
    });
    mockGetOAuthAccountInfo.mockReturnValue(null); // No token initially
    mockCreateOAuthLauncher.mockReturnValue(vi.fn());

    const cmd = createOAuthTokenCommand();
    const result = await cmd.execute(['adobe'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('masked-new-token-after-login\n');
    expect(mockOnOAuthLogin).toHaveBeenCalled();
  });

  it('triggers login when token is expired', async () => {
    const mockOnOAuthLogin = vi.fn(async () => {
      mockGetOAuthAccountInfo.mockReturnValue({
        token: 'refreshed-token',
        maskedValue: 'masked-refreshed-token',
        expired: false,
      });
    });

    mockGetRegisteredProviderConfig.mockReturnValue({
      id: 'adobe',
      name: 'Adobe',
      description: '',
      requiresApiKey: false,
      requiresBaseUrl: false,
      isOAuth: true,
      onOAuthLogin: mockOnOAuthLogin,
    });
    mockGetOAuthAccountInfo.mockReturnValue({
      token: 'old-expired-token',
      expiresAt: Date.now() - 120000,
      expired: true,
    });
    mockCreateOAuthLauncher.mockReturnValue(vi.fn());

    const cmd = createOAuthTokenCommand();
    const result = await cmd.execute(['adobe'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('masked-refreshed-token\n');
    expect(mockOnOAuthLogin).toHaveBeenCalled();
  });

  it('silently renews an expired token without triggering login', async () => {
    const onSilentRenew = vi.fn(async () => 'fresh-token');
    const onOAuthLogin = vi.fn();
    mockGetRegisteredProviderConfig.mockReturnValue({
      id: 'github',
      name: 'GitHub',
      description: '',
      requiresApiKey: false,
      requiresBaseUrl: false,
      isOAuth: true,
      onOAuthLogin,
      onSilentRenew,
    });
    mockGetOAuthAccountInfo
      .mockReturnValueOnce({ token: 'expired-token', expired: true })
      .mockReturnValueOnce({
        token: 'fresh-token',
        maskedValue: 'masked-fresh-token',
        expired: false,
      });

    const result = await createOAuthTokenCommand().execute(['github'], createMockCtx());

    expect(result).toEqual({ stdout: 'masked-fresh-token\n', stderr: '', exitCode: 0 });
    expect(onSilentRenew).toHaveBeenCalledTimes(1);
    expect(onOAuthLogin).not.toHaveBeenCalled();
    expect(mockCreateOAuthLauncher).not.toHaveBeenCalled();
  });

  it.each([
    ['returns null', vi.fn(async () => null)],
    [
      'throws',
      vi.fn(async () => {
        throw new Error('refresh failed');
      }),
    ],
  ])('falls back to login when silent renewal %s', async (_description, onSilentRenew) => {
    const onOAuthLogin = vi.fn(async () => {
      mockGetOAuthAccountInfo.mockReturnValue({
        token: 'interactive-token',
        maskedValue: 'masked-interactive-token',
        expired: false,
      });
    });
    mockGetRegisteredProviderConfig.mockReturnValue({
      id: 'github',
      name: 'GitHub',
      description: '',
      requiresApiKey: false,
      requiresBaseUrl: false,
      isOAuth: true,
      onOAuthLogin,
      onSilentRenew,
    });
    mockGetOAuthAccountInfo.mockReturnValue({ token: 'expired-token', expired: true });
    mockCreateOAuthLauncher.mockReturnValue(vi.fn());

    const result = await createOAuthTokenCommand().execute(['github'], createMockCtx());

    expect(result).toEqual({
      stdout: 'masked-interactive-token\n',
      stderr: '',
      exitCode: 0,
    });
    expect(onSilentRenew).toHaveBeenCalledTimes(1);
    expect(onOAuthLogin).toHaveBeenCalledTimes(1);
  });

  it('returns error when provider not found', async () => {
    mockGetRegisteredProviderConfig.mockReturnValue(undefined);

    const cmd = createOAuthTokenCommand();
    const result = await cmd.execute(['nonexistent'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unknown provider');
  });

  it('returns error when provider is not OAuth', async () => {
    mockGetRegisteredProviderConfig.mockReturnValue({
      id: 'anthropic',
      name: 'Anthropic',
      description: '',
      requiresApiKey: true,
      requiresBaseUrl: false,
    });

    const cmd = createOAuthTokenCommand();
    const result = await cmd.execute(['anthropic'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not an OAuth provider');
  });

  it('returns error when login fails', async () => {
    const mockOnOAuthLogin = vi.fn(async () => {
      throw new Error('popup closed by user');
    });

    mockGetRegisteredProviderConfig.mockReturnValue({
      id: 'adobe',
      name: 'Adobe',
      description: '',
      requiresApiKey: false,
      requiresBaseUrl: false,
      isOAuth: true,
      onOAuthLogin: mockOnOAuthLogin,
    });
    mockGetOAuthAccountInfo.mockReturnValue(null);
    mockCreateOAuthLauncher.mockReturnValue(vi.fn());

    const cmd = createOAuthTokenCommand();
    const result = await cmd.execute(['adobe'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('login failed');
    expect(result.stderr).toContain('popup closed by user');
  });

  it('returns error when login completes but no token saved', async () => {
    const mockOnOAuthLogin = vi.fn(async () => {
      // Login succeeds but doesn't save a token (unusual edge case)
    });

    mockGetRegisteredProviderConfig.mockReturnValue({
      id: 'adobe',
      name: 'Adobe',
      description: '',
      requiresApiKey: false,
      requiresBaseUrl: false,
      isOAuth: true,
      onOAuthLogin: mockOnOAuthLogin,
    });
    mockGetOAuthAccountInfo.mockReturnValue(null);
    mockCreateOAuthLauncher.mockReturnValue(vi.fn());

    const cmd = createOAuthTokenCommand();
    const result = await cmd.execute(['adobe'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no token was saved');
  });

  it('--list shows providers with status', async () => {
    mockGetRegisteredProviderIds.mockReturnValue(['adobe', 'my-corp']);
    mockGetRegisteredProviderConfig.mockImplementation((id) => {
      if (id === 'adobe')
        return {
          id: 'adobe',
          name: 'Adobe',
          description: '',
          requiresApiKey: false,
          requiresBaseUrl: false,
          isOAuth: true,
          onOAuthLogin: vi.fn(),
        };
      if (id === 'my-corp')
        return {
          id: 'my-corp',
          name: 'My Corp',
          description: '',
          requiresApiKey: false,
          requiresBaseUrl: false,
          isOAuth: true,
          onOAuthLogin: vi.fn(),
        };
      return undefined;
    });
    mockGetOAuthAccountInfo.mockImplementation((id) => {
      if (id === 'adobe')
        return {
          token: 'tok',
          expiresAt: Date.now() + 3600000 * 23,
          userName: 'karl@example.com',
          expired: false,
        };
      return null;
    });

    const cmd = createOAuthTokenCommand();
    const result = await cmd.execute(['--list'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('adobe');
    expect(result.stdout).toContain('karl@example.com');
    expect(result.stdout).toContain('my-corp (no token)');
  });

  it('--provider flag works', async () => {
    mockGetRegisteredProviderConfig.mockReturnValue({
      id: 'adobe',
      name: 'Adobe',
      description: '',
      requiresApiKey: false,
      requiresBaseUrl: false,
      isOAuth: true,
      onOAuthLogin: vi.fn(),
    });
    mockGetOAuthAccountInfo.mockReturnValue({
      token: 'flag-token',
      maskedValue: 'masked-flag-token',
      expired: false,
    });

    const cmd = createOAuthTokenCommand();
    const result = await cmd.execute(['--provider', 'adobe'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('masked-flag-token\n');
  });

  it('--provider without value returns error', async () => {
    const cmd = createOAuthTokenCommand();
    const result = await cmd.execute(['--provider'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--provider requires a value');
  });

  it('no args uses selected provider', async () => {
    mockGetSelectedProvider.mockReturnValue('adobe');
    mockGetRegisteredProviderConfig.mockReturnValue({
      id: 'adobe',
      name: 'Adobe',
      description: '',
      requiresApiKey: false,
      requiresBaseUrl: false,
      isOAuth: true,
      onOAuthLogin: vi.fn(),
    });
    mockGetOAuthAccountInfo.mockReturnValue({
      token: 'selected-provider-token',
      maskedValue: 'masked-selected-provider-token',
      expired: false,
    });

    const cmd = createOAuthTokenCommand();
    const result = await cmd.execute([], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('masked-selected-provider-token\n');
    expect(mockGetSelectedProvider).toHaveBeenCalled();
  });

  it('no args falls back to first OAuth provider when selected is not OAuth', async () => {
    mockGetSelectedProvider.mockReturnValue('azure-ai-foundry');
    mockGetRegisteredProviderConfig.mockImplementation((id) => {
      if (id === 'azure-ai-foundry')
        return {
          id: 'azure-ai-foundry',
          name: 'Azure',
          description: '',
          requiresApiKey: true,
          requiresBaseUrl: true,
        };
      if (id === 'adobe')
        return {
          id: 'adobe',
          name: 'Adobe',
          description: '',
          requiresApiKey: false,
          requiresBaseUrl: false,
          isOAuth: true,
          onOAuthLogin: vi.fn(),
        };
      return undefined;
    });
    mockGetRegisteredProviderIds.mockReturnValue(['azure-ai-foundry', 'adobe']);
    mockGetOAuthAccountInfo.mockReturnValue({
      token: 'fallback-token',
      maskedValue: 'masked-fallback-token',
      expired: false,
    });

    const cmd = createOAuthTokenCommand();
    const result = await cmd.execute([], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('masked-fallback-token\n');
    // Should have called getOAuthAccountInfo with 'adobe', not 'azure-ai-foundry'
    expect(mockGetOAuthAccountInfo).toHaveBeenCalledWith('adobe');
  });

  it('no args returns error when no OAuth providers exist', async () => {
    mockGetSelectedProvider.mockReturnValue('anthropic');
    mockGetRegisteredProviderConfig.mockReturnValue({
      id: 'anthropic',
      name: 'Anthropic',
      description: '',
      requiresApiKey: true,
      requiresBaseUrl: false,
    });
    mockGetRegisteredProviderIds.mockReturnValue(['anthropic']);

    const cmd = createOAuthTokenCommand();
    const result = await cmd.execute([], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no OAuth providers configured');
  });

  it('--list shows no providers when none are OAuth', async () => {
    mockGetRegisteredProviderIds.mockReturnValue(['anthropic']);
    mockGetRegisteredProviderConfig.mockReturnValue({
      id: 'anthropic',
      name: 'Anthropic',
      description: '',
      requiresApiKey: true,
      requiresBaseUrl: false,
    });

    const cmd = createOAuthTokenCommand();
    const result = await cmd.execute(['--list'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No OAuth providers');
  });

  it('--scope bypasses valid token cache and triggers login with scopes', async () => {
    const onSilentRenew = vi.fn(async () => 'silently-renewed-token');
    const mockOnOAuthLogin = vi.fn(async (_launcher, _onSuccess, _options) => {
      mockGetOAuthAccountInfo.mockReturnValue({
        token: 'scoped-token',
        maskedValue: 'masked-scoped-token',
        expired: false,
      });
    });

    mockGetRegisteredProviderConfig.mockReturnValue({
      id: 'github',
      name: 'GitHub',
      description: '',
      requiresApiKey: false,
      requiresBaseUrl: false,
      isOAuth: true,
      onOAuthLogin: mockOnOAuthLogin,
      onSilentRenew,
    });
    // Valid token exists — normally would return immediately
    mockGetOAuthAccountInfo.mockReturnValue({
      token: 'existing-token',
      expired: false,
    });
    mockCreateOAuthLauncher.mockReturnValue(vi.fn());

    const cmd = createOAuthTokenCommand();
    const result = await cmd.execute(['github', '--scope', 'repo,models:read'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('masked-scoped-token\n');
    // Login was triggered despite valid token
    expect(mockOnOAuthLogin).toHaveBeenCalled();
    expect(onSilentRenew).not.toHaveBeenCalled();
    // Scopes were passed through as the third argument
    expect(mockOnOAuthLogin).toHaveBeenCalledWith(expect.any(Function), expect.any(Function), {
      scopes: 'repo,models:read',
    });
  });

  it('--scope without value returns error', async () => {
    const cmd = createOAuthTokenCommand();
    const result = await cmd.execute(['github', '--scope'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--scope requires a value');
  });

  it('--scope with flag-like value returns error', async () => {
    const cmd = createOAuthTokenCommand();
    const result = await cmd.execute(['github', '--scope', '--provider'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--scope requires a value');
  });

  it('without --scope, does not pass options to onOAuthLogin', async () => {
    const mockOnOAuthLogin = vi.fn(async (_launcher, _onSuccess, _options) => {
      mockGetOAuthAccountInfo.mockReturnValue({
        token: 'default-token',
        maskedValue: 'masked-default-token',
        expired: false,
      });
    });

    mockGetRegisteredProviderConfig.mockReturnValue({
      id: 'github',
      name: 'GitHub',
      description: '',
      requiresApiKey: false,
      requiresBaseUrl: false,
      isOAuth: true,
      onOAuthLogin: mockOnOAuthLogin,
    });
    mockGetOAuthAccountInfo.mockReturnValue(null);
    mockCreateOAuthLauncher.mockReturnValue(vi.fn());

    const cmd = createOAuthTokenCommand();
    await cmd.execute(['github'], createMockCtx());
    expect(mockOnOAuthLogin).toHaveBeenCalledWith(
      expect.any(Function),
      expect.any(Function),
      undefined
    );
  });

  it('prints the masked value, never the real token', async () => {
    mockGetRegisteredProviderConfig.mockReturnValue({
      id: 'github',
      name: 'GitHub',
      description: '',
      requiresApiKey: false,
      requiresBaseUrl: false,
      isOAuth: true,
      onOAuthLogin: vi.fn(),
    });
    mockGetOAuthAccountInfo.mockReturnValue({
      token: 'ghp_REAL_must_not_leak',
      maskedValue: 'ghp_masked_safe',
      expired: false,
    });

    const cmd = createOAuthTokenCommand();
    const result = await cmd.execute(['github'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('ghp_masked_safe');
    expect(result.stdout).not.toContain('ghp_REAL_must_not_leak');
  });

  it('returns error when maskedValue is missing', async () => {
    mockGetRegisteredProviderConfig.mockReturnValue({
      id: 'github',
      name: 'GitHub',
      description: '',
      requiresApiKey: false,
      requiresBaseUrl: false,
      isOAuth: true,
      onOAuthLogin: vi.fn(),
    });
    mockGetOAuthAccountInfo.mockReturnValue({
      token: 'ghp_real_token',
      expired: false,
      // maskedValue is missing
    });

    const cmd = createOAuthTokenCommand();
    const result = await cmd.execute(['github'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no masked value');
    expect(result.stderr).toContain('github');
  });

  it('--renew triggers onSilentRenew and reports success', async () => {
    const onSilentRenew = vi.fn(async () => 'fresh-token');
    mockGetRegisteredProviderConfig.mockReturnValue({
      id: 'adobe',
      name: 'Adobe',
      isOAuth: true,
      onSilentRenew,
    } as never);
    mockGetOAuthAccountInfo
      .mockReturnValueOnce({ token: 'old', expiresAt: Date.now() - 1000, expired: true })
      .mockReturnValueOnce({
        token: 'fresh-token',
        expiresAt: Date.now() + 24 * 3600_000,
        expired: false,
      });

    const cmd = createOAuthTokenCommand();
    const result = await cmd.execute(['--renew', 'adobe'], createMockCtx());

    expect(onSilentRenew).toHaveBeenCalledTimes(1);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('SUCCESS');
  });

  it('--renew reports failure when onSilentRenew returns null', async () => {
    const onSilentRenew = vi.fn(async () => null);
    mockGetRegisteredProviderConfig.mockReturnValue({
      id: 'adobe',
      name: 'Adobe',
      isOAuth: true,
      onSilentRenew,
    } as never);
    mockGetOAuthAccountInfo.mockReturnValue({
      token: 'old',
      expiresAt: Date.now() - 1000,
      expired: true,
    });

    const cmd = createOAuthTokenCommand();
    const result = await cmd.execute(['--renew', 'adobe'], createMockCtx());

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('FAILED');
  });

  it('--renew errors when the provider has no onSilentRenew hook', async () => {
    mockGetRegisteredProviderConfig.mockReturnValue({
      id: 'noauth',
      name: 'NoAuth',
      isOAuth: true,
    } as never);

    const cmd = createOAuthTokenCommand();
    const result = await cmd.execute(['--renew', 'noauth'], createMockCtx());

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no onSilentRenew hook');
  });

  it.each([
    ['provider-first', ['github', '--expire']],
    ['flag-first', ['--expire', 'github']],
    ['selected-provider', ['--expire']],
  ])('--expire back-dates expiry and preserves tokens (%s)', async (_label, args) => {
    const before = Date.now();
    mockGetSelectedProvider.mockReturnValue('github');
    mockGetRegisteredProviderConfig.mockReturnValue({
      id: 'github',
      name: 'GitHub',
      isOAuth: true,
      onSilentRenew: vi.fn(),
    } as never);
    mockGetAccounts.mockReturnValue([
      {
        providerId: 'github',
        apiKey: '',
        accessToken: 'existing-access-token',
        refreshToken: 'existing-refresh-token',
        tokenExpiresAt: before + 8 * 3600_000,
        userName: 'octocat',
      },
    ]);

    const result = await createOAuthTokenCommand().execute(args, createMockCtx());

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      'oauth-token github: stored token marked expired; next network op will trigger silent renewal.\n'
    );
    expect(mockSaveOAuthAccount).toHaveBeenCalledTimes(1);
    const saved = mockSaveOAuthAccount.mock.calls[0]?.[0];
    expect(saved).toMatchObject({
      providerId: 'github',
      accessToken: 'existing-access-token',
      refreshToken: 'existing-refresh-token',
      userName: 'octocat',
    });
    expect(saved?.tokenExpiresAt).toBeGreaterThanOrEqual(before - 1000);
    expect(saved?.tokenExpiresAt).toBeLessThanOrEqual(Date.now() - 1000);
  });

  it('--expire returns a clear error when no account is stored', async () => {
    mockGetRegisteredProviderConfig.mockReturnValue({
      id: 'github',
      name: 'GitHub',
      isOAuth: true,
      onSilentRenew: vi.fn(),
    } as never);
    mockGetAccounts.mockReturnValue([]);

    const result = await createOAuthTokenCommand().execute(['github', '--expire'], createMockCtx());

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no stored OAuth account for "github"');
    expect(mockSaveOAuthAccount).not.toHaveBeenCalled();
  });

  it('--expire reports persistence failures', async () => {
    mockGetRegisteredProviderConfig.mockReturnValue({
      id: 'github',
      name: 'GitHub',
      isOAuth: true,
      onSilentRenew: vi.fn(),
    } as never);
    mockGetAccounts.mockReturnValue([
      { providerId: 'github', apiKey: '', accessToken: 'access', refreshToken: 'refresh' },
    ]);
    mockSaveOAuthAccount.mockRejectedValueOnce(new Error('storage unavailable'));

    const result = await createOAuthTokenCommand().execute(['github', '--expire'], createMockCtx());

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('failed to update "github": storage unavailable');
  });

  it('--from-file reads JSON via ctx.fs and runs the intercept launcher', async () => {
    const config = {
      authorizeUrl: 'https://auth.example.com/authorize?client_id=abc',
      redirectUriPattern: 'http://127.0.0.1:56121/*',
    };
    const launcher = vi.fn(async () => 'http://127.0.0.1:56121/?code=captured-code');
    mockCreateInterceptingOAuthLauncherForCurrentRuntime.mockResolvedValue(launcher);

    const ctx = createMockCtx();
    const readFile = vi.fn(async () => JSON.stringify(config));
    (ctx.fs as unknown as { readFile: typeof readFile }).readFile = readFile;

    const cmd = createOAuthTokenCommand();
    const result = await cmd.execute(
      ['--from-file', 'oauth/xai.json'],
      ctx as unknown as Parameters<typeof cmd.execute>[1]
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('http://127.0.0.1:56121/?code=captured-code\n');
    // Relative path was resolved against cwd before reading.
    expect(readFile).toHaveBeenCalledWith('/home/oauth/xai.json');
    expect(launcher).toHaveBeenCalledTimes(1);
  });

  it('--from-file passes absolute paths through unchanged', async () => {
    const config = {
      authorizeUrl: 'https://auth.example.com/authorize',
      redirectUriPattern: 'http://127.0.0.1:56121/*',
    };
    const launcher = vi.fn(async () => 'http://127.0.0.1:56121/?code=abs');
    mockCreateInterceptingOAuthLauncherForCurrentRuntime.mockResolvedValue(launcher);

    const ctx = createMockCtx();
    const readFile = vi.fn(async () => JSON.stringify(config));
    (ctx.fs as unknown as { readFile: typeof readFile }).readFile = readFile;

    const cmd = createOAuthTokenCommand();
    const result = await cmd.execute(
      ['--from-file', '/workspace/.slicc/oauth/xai.json'],
      ctx as unknown as Parameters<typeof cmd.execute>[1]
    );

    expect(result.exitCode).toBe(0);
    expect(readFile).toHaveBeenCalledWith('/workspace/.slicc/oauth/xai.json');
  });

  it('--from-file surfaces a read failure as a "failed to read" error', async () => {
    const ctx = createMockCtx();
    const readFile = vi.fn(async () => {
      throw new Error('ENOENT: no such file');
    });
    (ctx.fs as unknown as { readFile: typeof readFile }).readFile = readFile;

    const cmd = createOAuthTokenCommand();
    const result = await cmd.execute(
      ['--from-file', 'missing.json'],
      ctx as unknown as Parameters<typeof cmd.execute>[1]
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('failed to read missing.json');
    expect(result.stderr).toContain('ENOENT');
    expect(mockCreateInterceptingOAuthLauncherForCurrentRuntime).not.toHaveBeenCalled();
  });

  it('--from-file requires a path', async () => {
    const cmd = createOAuthTokenCommand();
    const result = await cmd.execute(['--from-file'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--from-file requires a path');
  });
});
