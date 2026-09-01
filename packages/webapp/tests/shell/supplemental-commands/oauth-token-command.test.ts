import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock modules before importing the command
vi.mock('../../../src/providers/account-store.js', () => ({
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
  getAccounts,
  getOAuthAccountInfo,
  getSelectedProvider,
  saveOAuthAccount,
} from '../../../src/providers/account-store.js';
import {
  getRegisteredProviderConfig,
  getRegisteredProviderIds,
} from '../../../src/providers/index.js';
import {
  createInterceptingOAuthLauncherForCurrentRuntime,
  createOAuthLauncher,
} from '../../../src/providers/oauth-service.js';
import { createOAuthTokenCommand } from '../../../src/shell/supplemental-commands/oauth-token-command.js';
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
    expect(result.stdout).toContain('--force-login');
    expect(result.stdout).toContain('Does not revoke anything upstream');
    // The escalation ladder has to be discoverable without failing first.
    expect(result.stdout).toContain('--check');
    expect(result.stdout).toContain('Held vs working');
    expect(result.stdout).toContain('fall back to --force-login');
    expect(result.stdout).toContain('Exit codes:');
    expect(result.stdout).toContain('automated recovery is exhausted');
  });

  it('rejects an unknown flag instead of silently ignoring it', async () => {
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
      expired: false,
    });

    const cmd = createOAuthTokenCommand();
    const result = await cmd.execute(['adobe', '--bogus'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unknown flag: --bogus');
    expect(result.stdout).toBe('');
  });

  it('rejects boolean flags with attached values', async () => {
    mockGetRegisteredProviderConfig.mockReturnValue({
      id: 'github',
      name: 'GitHub',
      description: '',
      requiresApiKey: false,
      requiresBaseUrl: false,
      isOAuth: true,
      onOAuthLogin: vi.fn(),
    });
    mockGetAccounts.mockReturnValue([
      {
        providerId: 'github',
        accessToken: 'tok',
        tokenExpiresAt: Date.now() + 3600000,
        apiKey: '',
      },
    ]);
    mockGetRegisteredProviderIds.mockReturnValue(['github']);
    mockGetRegisteredProviderConfig.mockImplementation((id: string) =>
      id === 'github'
        ? {
            id: 'github',
            name: 'GitHub',
            description: '',
            requiresApiKey: false,
            requiresBaseUrl: false,
            isOAuth: true,
            onSilentRenew: vi.fn(),
            onOAuthLogin: vi.fn(),
          }
        : undefined
    );

    const cmd = createOAuthTokenCommand();
    const expire = await cmd.execute(['github', '--expire=false'], createMockCtx());
    expect(expire.exitCode).toBe(1);
    expect(expire.stderr).toContain('unknown flag: --expire');
    expect(mockSaveOAuthAccount).not.toHaveBeenCalled();

    const list = await cmd.execute(['--list=garbage'], createMockCtx());
    expect(list.exitCode).toBe(1);
    expect(list.stderr).toContain('unknown flag: --list');
  });

  it('accepts known flags after the provider positional', async () => {
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
      token: 'tok',
      maskedValue: 'masked-tok',
      scopes: 'repo',
      expiresAt: Date.now() + 3600000,
      expired: false,
    });

    const cmd = createOAuthTokenCommand();
    const result = await cmd.execute(['github', '--scope', 'repo'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('masked-tok\n');
  });

  it('treats tokens after -- as positional, not flags', async () => {
    mockGetRegisteredProviderConfig.mockReturnValue({
      id: '--weird',
      name: 'Weird',
      description: '',
      requiresApiKey: false,
      requiresBaseUrl: false,
      isOAuth: true,
      onOAuthLogin: vi.fn(),
    });
    mockGetOAuthAccountInfo.mockReturnValue({
      token: 'tok',
      maskedValue: 'masked-weird',
      expiresAt: Date.now() + 3600000,
      expired: false,
    });

    const cmd = createOAuthTokenCommand();
    const result = await cmd.execute(['--', '--weird'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('masked-weird\n');
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
    const mockOnOAuthLogin = vi.fn(async (_launcher, onSuccess) => {
      // Simulate login saving a token
      mockGetOAuthAccountInfo.mockReturnValue({
        token: 'new-token-after-login',
        maskedValue: 'masked-new-token-after-login',
        expired: false,
      });
      onSuccess();
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
    const mockOnOAuthLogin = vi.fn(async (_launcher, onSuccess) => {
      mockGetOAuthAccountInfo.mockReturnValue({
        token: 'refreshed-token',
        maskedValue: 'masked-refreshed-token',
        expired: false,
      });
      onSuccess();
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
    const onOAuthLogin = vi.fn(async (_launcher, onSuccess) => {
      mockGetOAuthAccountInfo.mockReturnValue({
        token: 'interactive-token',
        maskedValue: 'masked-interactive-token',
        expired: false,
      });
      onSuccess();
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
    const mockOnOAuthLogin = vi.fn(async (_launcher, onSuccess) => {
      // Login reports success but doesn't save a token (unusual edge case)
      onSuccess();
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

  it('does not fall back to a stale token when the login attempt never completes (#1915)', async () => {
    // The popup was cancelled / timed out / nobody could click: the provider
    // hook returns WITHOUT calling onSuccess. The expired token that forced
    // this login is still stored — it must not be reported as success.
    const mockOnOAuthLogin = vi.fn(async () => {});
    mockGetRegisteredProviderConfig.mockReturnValue({
      id: 'github',
      name: 'GitHub',
      description: '',
      requiresApiKey: false,
      requiresBaseUrl: false,
      isOAuth: true,
      onOAuthLogin: mockOnOAuthLogin,
    });
    mockGetOAuthAccountInfo.mockReturnValue({
      token: 'stale-expired-token',
      maskedValue: 'masked-stale-expired-token',
      expiresAt: Date.now() - 120000,
      expired: true,
    });
    mockCreateOAuthLauncher.mockReturnValue(vi.fn());

    const result = await createOAuthTokenCommand().execute(['github'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('interactive login was not completed');
    expect(result.stdout).not.toContain('masked-stale-expired-token');
  });

  it('does not report a still-valid cached token as the outcome of an incomplete forced login', async () => {
    const mockOnOAuthLogin = vi.fn(async () => {});
    mockGetRegisteredProviderConfig.mockReturnValue({
      id: 'github',
      name: 'GitHub',
      description: '',
      requiresApiKey: false,
      requiresBaseUrl: false,
      isOAuth: true,
      onOAuthLogin: mockOnOAuthLogin,
    });
    mockGetOAuthAccountInfo.mockReturnValue({
      token: 'valid-cached-token',
      maskedValue: 'masked-valid-cached-token',
      expired: false,
    });
    mockCreateOAuthLauncher.mockReturnValue(vi.fn());

    const result = await createOAuthTokenCommand().execute(
      ['github', '--force-login'],
      createMockCtx()
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('interactive login was not completed');
  });

  it('fails when a completed login leaves only an expired token behind', async () => {
    const mockOnOAuthLogin = vi.fn(async (_launcher, onSuccess) => {
      mockGetOAuthAccountInfo.mockReturnValue({
        token: 'immediately-expired-token',
        maskedValue: 'masked-immediately-expired-token',
        expiresAt: Date.now() - 1000,
        expired: true,
      });
      onSuccess();
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

    const result = await createOAuthTokenCommand().execute(['github'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('already expired');
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
          scopes: 'repo,read:user',
          expired: false,
        };
      return null;
    });

    const cmd = createOAuthTokenCommand();
    const result = await cmd.execute(['--list'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('adobe');
    expect(result.stdout).toContain('karl@example.com');
    expect(result.stdout).toContain('scopes: repo,read:user');
    expect(result.stdout).toContain('my-corp (no token)');
    // "logged in" claimed more than local storage knows: the same listing
    // said "logged in" for a token GitHub had already invalidated (#2695).
    expect(result.stdout).not.toContain('logged in');
    expect(result.stdout).toContain('token held for karl@example.com');
    expect(result.stdout).toContain('Local state only');
    expect(result.stdout).toContain('oauth-token --check <id>');
  });

  it('--list marks a past-expiry token as held, not as logged in', async () => {
    mockGetRegisteredProviderIds.mockReturnValue(['adobe']);
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
      token: 'tok',
      expiresAt: Date.now() - 1000,
      userName: 'karl@example.com',
      expired: true,
    });

    const cmd = createOAuthTokenCommand();
    const result = await cmd.execute(['--list'], createMockCtx());

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      'adobe (token held for karl@example.com, past its local expiry, renewal needed)'
    );
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

  it('--scope triggers login when the granted scopes are unknown', async () => {
    const onSilentRenew = vi.fn(async () => 'silently-renewed-token');
    const mockOnOAuthLogin = vi.fn(async (_launcher, onSuccess, _options) => {
      mockGetOAuthAccountInfo.mockReturnValue({
        token: 'scoped-token',
        maskedValue: 'masked-scoped-token',
        expired: false,
      });
      onSuccess();
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
    // Valid token exists, but it predates scope recording — fail safe.
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

  it('--scope reuses the cached token when the granted scopes cover it', async () => {
    const onOAuthLogin = vi.fn();
    mockGetRegisteredProviderConfig.mockReturnValue({
      id: 'github',
      name: 'GitHub',
      description: '',
      requiresApiKey: false,
      requiresBaseUrl: false,
      isOAuth: true,
      onOAuthLogin,
    });
    mockGetOAuthAccountInfo.mockReturnValue({
      token: 'existing-token',
      maskedValue: 'masked-existing-token',
      scopes: 'repo,read:user,user:email',
      expired: false,
    });

    const result = await createOAuthTokenCommand().execute(
      ['github', '--scope', 'repo'],
      createMockCtx()
    );

    expect(result).toEqual({ stdout: 'masked-existing-token\n', stderr: '', exitCode: 0 });
    expect(onOAuthLogin).not.toHaveBeenCalled();
    expect(mockCreateOAuthLauncher).not.toHaveBeenCalled();
  });

  it('--scope triggers login when the granted scopes fall short', async () => {
    const onOAuthLogin = vi.fn(async (_launcher, onSuccess) => {
      mockGetOAuthAccountInfo.mockReturnValue({
        token: 'widened-token',
        maskedValue: 'masked-widened-token',
        scopes: 'repo,admin:org',
        expired: false,
      });
      onSuccess();
    });
    mockGetRegisteredProviderConfig.mockReturnValue({
      id: 'github',
      name: 'GitHub',
      description: '',
      requiresApiKey: false,
      requiresBaseUrl: false,
      isOAuth: true,
      onOAuthLogin,
    });
    mockGetOAuthAccountInfo.mockReturnValue({
      token: 'existing-token',
      maskedValue: 'masked-existing-token',
      scopes: 'repo,read:user',
      expired: false,
    });
    mockCreateOAuthLauncher.mockReturnValue(vi.fn());

    const result = await createOAuthTokenCommand().execute(
      ['github', '--scope', 'repo,admin:org'],
      createMockCtx()
    );

    expect(result.stdout).toBe('masked-widened-token\n');
    expect(onOAuthLogin).toHaveBeenCalledTimes(1);
  });

  it('--scope re-checks the scopes recorded by a silent renewal', async () => {
    const onSilentRenew = vi.fn(async () => 'renewed-token');
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
      .mockReturnValueOnce({ token: 'expired-token', scopes: 'repo', expired: true })
      .mockReturnValueOnce({
        token: 'renewed-token',
        maskedValue: 'masked-renewed-token',
        scopes: 'repo,read:user',
        expired: false,
      });

    const result = await createOAuthTokenCommand().execute(
      ['github', '--scope', 'read:user'],
      createMockCtx()
    );

    expect(result).toEqual({ stdout: 'masked-renewed-token\n', stderr: '', exitCode: 0 });
    expect(onSilentRenew).toHaveBeenCalledTimes(1);
    expect(onOAuthLogin).not.toHaveBeenCalled();
  });

  it('--force-login logs in even when the cached scopes are satisfied', async () => {
    const onOAuthLogin = vi.fn(async (_launcher, onSuccess) => {
      mockGetOAuthAccountInfo.mockReturnValue({
        token: 'forced-token',
        maskedValue: 'masked-forced-token',
        scopes: 'repo',
        expired: false,
      });
      onSuccess();
    });
    mockGetRegisteredProviderConfig.mockReturnValue({
      id: 'github',
      name: 'GitHub',
      description: '',
      requiresApiKey: false,
      requiresBaseUrl: false,
      isOAuth: true,
      onOAuthLogin,
    });
    mockGetOAuthAccountInfo.mockReturnValue({
      token: 'existing-token',
      maskedValue: 'masked-existing-token',
      scopes: 'repo',
      expired: false,
    });
    mockCreateOAuthLauncher.mockReturnValue(vi.fn());

    const result = await createOAuthTokenCommand().execute(
      ['github', '--scope', 'repo', '--force-login'],
      createMockCtx()
    );

    expect(result.stdout).toBe('masked-forced-token\n');
    expect(onOAuthLogin).toHaveBeenCalledWith(expect.any(Function), expect.any(Function), {
      scopes: 'repo',
    });
  });

  it('--force-login without --scope skips a valid cached token', async () => {
    const onOAuthLogin = vi.fn(async (_launcher, onSuccess) => {
      mockGetOAuthAccountInfo.mockReturnValue({
        token: 'forced-token',
        maskedValue: 'masked-forced-token',
        expired: false,
      });
      onSuccess();
    });
    mockGetRegisteredProviderConfig.mockReturnValue({
      id: 'github',
      name: 'GitHub',
      description: '',
      requiresApiKey: false,
      requiresBaseUrl: false,
      isOAuth: true,
      onOAuthLogin,
    });
    mockGetOAuthAccountInfo.mockReturnValue({
      token: 'existing-token',
      maskedValue: 'masked-existing-token',
      expired: false,
    });
    mockCreateOAuthLauncher.mockReturnValue(vi.fn());

    const result = await createOAuthTokenCommand().execute(
      ['github', '--force-login'],
      createMockCtx()
    );

    expect(result.stdout).toBe('masked-forced-token\n');
    expect(onOAuthLogin).toHaveBeenCalledWith(
      expect.any(Function),
      expect.any(Function),
      undefined
    );
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
    // Prose must stay off stdout — a caller reads stdout as the token, and
    // this sentence is long enough to pass a naive length check (#2695).
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('no usable token for github');
    expect(result.stderr).toContain('oauth-token github --force-login');
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

    // No upstream check exists for this provider, so the decline is
    // unconfirmed: name the likely fix, but never claim a retry is pointless.
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('DECLINED');
    expect(result.stdout).toContain('Unconfirmed');
    expect(result.stdout).toContain('Likely fix: oauth-token adobe --force-login');
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

  it('--renew never calls a locally-unexpired token "valid"', async () => {
    const onSilentRenew = vi.fn(async () => null);
    mockGetRegisteredProviderConfig.mockReturnValue({
      id: 'github',
      name: 'GitHub',
      isOAuth: true,
      onSilentRenew,
      onValidateToken: async () => ({ status: 'rejected', detail: 'HTTP 401 Unauthorized' }),
    } as never);
    // The exact starting state from #2695: stored, inside its local expiry,
    // and dead upstream. Reporting it as "valid" sent the caller hunting for
    // a bug in the OAuth service.
    mockGetOAuthAccountInfo.mockReturnValue({
      token: 'gho_dead',
      expiresAt: Date.now() + 3600_000,
      expired: false,
    });

    const cmd = createOAuthTokenCommand();
    const result = await cmd.execute(['--renew', 'github'], createMockCtx());

    // The provider itself confirms the token is dead, so exit 3 is earned.
    expect(result.exitCode).toBe(3);
    expect(result.stdout).not.toMatch(/before: valid/);
    expect(result.stdout).toContain('stored token: present');
    expect(result.stdout).toContain('not validated upstream');
    expect(result.stdout).toContain('upstream check: REJECTED');
    expect(result.stdout).toContain('Local expiry was never proof of validity');
    expect(result.stdout).toContain('→ Fix: oauth-token github --force-login');
  });

  it('--renew stays at exit 1 when the upstream check cannot confirm the decline', async () => {
    // Provider hooks collapse transport failures into `null` too, so a decline
    // the provider will not corroborate must not send a caller to a human.
    mockGetRegisteredProviderConfig.mockReturnValue({
      id: 'github',
      name: 'GitHub',
      isOAuth: true,
      onSilentRenew: async () => null,
      onValidateToken: async () => ({ status: 'unknown', detail: 'HTTP 502 Bad Gateway' }),
    } as never);
    mockGetOAuthAccountInfo.mockReturnValue({ token: 'gho_x', expired: false });

    const cmd = createOAuthTokenCommand();
    const result = await cmd.execute(['--renew', 'github'], createMockCtx());

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Unconfirmed:');
    expect(result.stdout).toContain('(upstream check: HTTP 502 Bad Gateway)');
    expect(result.stdout).toContain('Likely fix');
    expect(result.stdout).not.toContain('→ Fix:');
  });

  it('--renew reports a still-working token when the decline was not a lapse', async () => {
    mockGetRegisteredProviderConfig.mockReturnValue({
      id: 'github',
      name: 'GitHub',
      isOAuth: true,
      onSilentRenew: async () => null,
      onValidateToken: async () => ({ status: 'accepted', userName: 'trieloff' }),
    } as never);
    mockGetOAuthAccountInfo.mockReturnValue({ token: 'gho_x', expired: false });

    const cmd = createOAuthTokenCommand();
    const result = await cmd.execute(['--renew', 'github'], createMockCtx());

    // Renewal did not happen (so not 0-as-success), but callers are not
    // blocked and no human is needed.
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('upstream check: ACCEPTED (as trieloff)');
    expect(result.stdout).toContain('No login needed');
    expect(result.stdout).not.toContain('--force-login');
  });

  it('--renew survives an upstream check that throws', async () => {
    mockGetRegisteredProviderConfig.mockReturnValue({
      id: 'github',
      name: 'GitHub',
      isOAuth: true,
      onSilentRenew: async () => null,
      onValidateToken: async () => {
        throw new Error('check exploded');
      },
    } as never);
    mockGetOAuthAccountInfo.mockReturnValue({ token: 'gho_x', expired: false });

    const cmd = createOAuthTokenCommand();
    const result = await cmd.execute(['--renew', 'github'], createMockCtx());

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('(upstream check: check exploded)');
  });

  it('--renew reports a thrown renewal as exit 1 but still names the fallback', async () => {
    const onSilentRenew = vi.fn(async () => {
      throw new Error('network down');
    });
    mockGetRegisteredProviderConfig.mockReturnValue({
      id: 'adobe',
      name: 'Adobe',
      isOAuth: true,
      onSilentRenew,
    } as never);
    mockGetOAuthAccountInfo.mockReturnValue({ token: 'old', expired: true });

    const cmd = createOAuthTokenCommand();
    const result = await cmd.execute(['--renew', 'adobe'], createMockCtx());

    // A throw may be transient (offline, 5xx), so it must NOT claim that a
    // human is required — that is exit 3's meaning — nor tell the caller to
    // stop retrying.
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('ERROR — network down');
    expect(result.stdout).toContain('Retry it.');
    expect(result.stdout).toContain('If it keeps failing: oauth-token adobe --force-login');
    expect(result.stdout).not.toContain('→ Fix:');
  });

  it('--check reports ACCEPTED when the provider honours the token', async () => {
    const onValidateToken = vi.fn(async () => ({
      status: 'accepted' as const,
      userName: 'trieloff',
    }));
    mockGetRegisteredProviderConfig.mockReturnValue({
      id: 'github',
      name: 'GitHub',
      isOAuth: true,
      onValidateToken,
    } as never);
    mockGetOAuthAccountInfo.mockReturnValue({
      token: 'gho_live',
      expiresAt: Date.now() + 3600_000,
      expired: false,
    });

    const cmd = createOAuthTokenCommand();
    const result = await cmd.execute(['--check', 'github'], createMockCtx());

    expect(onValidateToken).toHaveBeenCalledTimes(1);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('ACCEPTED (as trieloff)');
  });

  it('--check sends a refused token to --renew first when renewal is possible', async () => {
    const onValidateToken = vi.fn(async () => ({
      status: 'rejected' as const,
      detail: 'HTTP 401 Unauthorized',
    }));
    mockGetRegisteredProviderConfig.mockReturnValue({
      id: 'github',
      name: 'GitHub',
      isOAuth: true,
      onSilentRenew: vi.fn(),
      onValidateToken,
    } as never);
    mockGetOAuthAccountInfo.mockReturnValue({
      token: 'gho_dead',
      expiresAt: Date.now() + 3600_000,
      expired: false,
    });

    const cmd = createOAuthTokenCommand();
    const result = await cmd.execute(['--check', 'github'], createMockCtx());

    // A stored refresh token can still replace a refused access token, so the
    // automated rung is not exhausted and this is not a job for a human yet.
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('REJECTED');
    expect(result.stdout).toContain('HTTP 401 Unauthorized');
    expect(result.stdout).toContain('→ Next: oauth-token github --renew');
  });

  it('--check reports REJECTED with exit 3 when no silent renewal exists', async () => {
    const onValidateToken = vi.fn(async () => ({
      status: 'rejected' as const,
      detail: 'HTTP 401 Unauthorized',
    }));
    mockGetRegisteredProviderConfig.mockReturnValue({
      id: 'github',
      name: 'GitHub',
      isOAuth: true,
      onValidateToken,
    } as never);
    mockGetOAuthAccountInfo.mockReturnValue({ token: 'gho_dead', expired: false });

    const cmd = createOAuthTokenCommand();
    const result = await cmd.execute(['--check', 'github'], createMockCtx());

    expect(result.exitCode).toBe(3);
    expect(result.stdout).toContain('nothing automated is left');
    expect(result.stdout).toContain('→ Fix: oauth-token github --force-login');
  });

  it('--check reports UNKNOWN with exit 1 when the check itself fails', async () => {
    const onValidateToken = vi.fn(async () => {
      throw new Error('Failed to fetch');
    });
    mockGetRegisteredProviderConfig.mockReturnValue({
      id: 'github',
      name: 'GitHub',
      isOAuth: true,
      onValidateToken,
    } as never);
    mockGetOAuthAccountInfo.mockReturnValue({ token: 'gho_x', expired: false });

    const cmd = createOAuthTokenCommand();
    const result = await cmd.execute(['--check', 'github'], createMockCtx());

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('UNKNOWN');
    expect(result.stdout).toContain('Failed to fetch');
    expect(result.stdout).toContain('says nothing about the token');
  });

  it('--check needs an interactive login when no token is stored at all', async () => {
    const onValidateToken = vi.fn();
    mockGetRegisteredProviderConfig.mockReturnValue({
      id: 'github',
      name: 'GitHub',
      isOAuth: true,
      onValidateToken,
    } as never);
    mockGetOAuthAccountInfo.mockReturnValue(null);

    const cmd = createOAuthTokenCommand();
    const result = await cmd.execute(['--check', 'github'], createMockCtx());

    expect(onValidateToken).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toContain('none stored');
    expect(result.stdout).toContain('oauth-token github --force-login');
  });

  it('--check explains itself for a provider with no upstream check', async () => {
    mockGetRegisteredProviderConfig.mockReturnValue({
      id: 'adobe',
      name: 'Adobe',
      isOAuth: true,
    } as never);

    const cmd = createOAuthTokenCommand();
    const result = await cmd.execute(['--check', 'adobe'], createMockCtx());

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('cannot be checked upstream');
  });

  it('--check falls back to a provider that supports the hook', async () => {
    const onValidateToken = vi.fn(async () => ({ status: 'accepted' as const }));
    mockGetSelectedProvider.mockReturnValue('cerebras');
    mockGetRegisteredProviderIds.mockReturnValue(['cerebras', 'github']);
    mockGetRegisteredProviderConfig.mockImplementation((id: string) =>
      id === 'github'
        ? ({ id: 'github', name: 'GitHub', isOAuth: true, onValidateToken } as never)
        : ({ id: 'cerebras', name: 'Cerebras' } as never)
    );
    mockGetOAuthAccountInfo.mockReturnValue({ token: 'gho_live', expired: false });

    const cmd = createOAuthTokenCommand();
    const result = await cmd.execute(['--check'], createMockCtx());

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('oauth-token --check github');
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
    expect(result.stderr).toContain('--from-file requires a value');
  });
});
