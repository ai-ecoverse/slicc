import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { IFileSystem } from 'just-bash';

// Mock modules before importing the command
vi.mock('../../../src/ui/provider-settings.js', () => ({
  getOAuthAccountInfo: vi.fn(),
  getSelectedProvider: vi.fn(),
  getAccounts: vi.fn(() => []),
}));

vi.mock('../../../src/providers/index.js', () => ({
  getRegisteredProviderConfig: vi.fn(),
  getRegisteredProviderIds: vi.fn(() => []),
}));

vi.mock('../../../src/providers/oauth-service.js', () => ({
  createOAuthLauncher: vi.fn(() => vi.fn()),
}));

import { createOAuthTokenCommand } from '../../../src/shell/supplemental-commands/oauth-token-command.js';
import {
  getOAuthAccountInfo,
  getSelectedProvider,
  getAccounts,
} from '../../../src/ui/provider-settings.js';
import {
  getRegisteredProviderConfig,
  getRegisteredProviderIds,
} from '../../../src/providers/index.js';
import { createOAuthLauncher } from '../../../src/providers/oauth-service.js';

const mockGetOAuthAccountInfo = vi.mocked(getOAuthAccountInfo);
const mockGetSelectedProvider = vi.mocked(getSelectedProvider);
const mockGetRegisteredProviderConfig = vi.mocked(getRegisteredProviderConfig);
const mockGetRegisteredProviderIds = vi.mocked(getRegisteredProviderIds);
const mockGetAccounts = vi.mocked(getAccounts);
const mockCreateOAuthLauncher = vi.mocked(createOAuthLauncher);

function createMockCtx() {
  const fs: Partial<IFileSystem> = {
    resolvePath: (base: string, path: string) => (path.startsWith('/') ? path : `${base}/${path}`),
  };
  return {
    fs: fs as IFileSystem,
    cwd: '/home',
    env: new Map<string, string>(),
    stdin: '',
  };
}

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
      expiresAt: Date.now() + 3600000,
      userName: 'karl',
      expired: false,
    });

    const cmd = createOAuthTokenCommand();
    const result = await cmd.execute(['adobe'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('valid-access-token\n');
  });

  it('triggers login when no token exists, returns new token', async () => {
    const mockOnOAuthLogin = vi.fn(async (_launcher, _onSuccess) => {
      // Simulate login saving a token
      mockGetOAuthAccountInfo.mockReturnValue({
        token: 'new-token-after-login',
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
    expect(result.stdout).toBe('new-token-after-login\n');
    expect(mockOnOAuthLogin).toHaveBeenCalled();
  });

  it('triggers login when token is expired', async () => {
    const mockOnOAuthLogin = vi.fn(async () => {
      mockGetOAuthAccountInfo.mockReturnValue({
        token: 'refreshed-token',
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
    expect(result.stdout).toBe('refreshed-token\n');
    expect(mockOnOAuthLogin).toHaveBeenCalled();
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
      expired: false,
    });

    const cmd = createOAuthTokenCommand();
    const result = await cmd.execute(['--provider', 'adobe'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('flag-token\n');
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
      expired: false,
    });

    const cmd = createOAuthTokenCommand();
    const result = await cmd.execute([], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('selected-provider-token\n');
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
    mockGetOAuthAccountInfo.mockReturnValue({ token: 'fallback-token', expired: false });

    const cmd = createOAuthTokenCommand();
    const result = await cmd.execute([], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('fallback-token\n');
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
    const mockOnOAuthLogin = vi.fn(async (_launcher, _onSuccess, _options) => {
      mockGetOAuthAccountInfo.mockReturnValue({
        token: 'scoped-token',
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
    // Valid token exists — normally would return immediately
    mockGetOAuthAccountInfo.mockReturnValue({
      token: 'existing-token',
      expired: false,
    });
    mockCreateOAuthLauncher.mockReturnValue(vi.fn());

    const cmd = createOAuthTokenCommand();
    const result = await cmd.execute(['github', '--scope', 'repo,models:read'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('scoped-token\n');
    // Login was triggered despite valid token
    expect(mockOnOAuthLogin).toHaveBeenCalled();
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
});
