import { describe, expect, it, vi } from 'vitest';
import { ensureFreshGithubToken, githubOAuthDomains } from '../../src/git/github-oauth.js';
import { getRegisteredProviderConfig } from '../../src/providers/index.js';
import { GITHUB_DOMAINS } from '../../src/shell/supplemental-commands/git-credential-command.js';

vi.mock('../../src/providers/index.js', () => ({
  getRegisteredProviderConfig: vi.fn(),
}));

const getConfig = vi.mocked(getRegisteredProviderConfig);

describe('ensureFreshGithubToken', () => {
  it('no-ops when the github provider is unregistered', async () => {
    getConfig.mockReturnValue(undefined);
    await expect(ensureFreshGithubToken()).resolves.toBeUndefined();
    await expect(ensureFreshGithubToken({ force: true })).resolves.toBeUndefined();
  });

  it('calls getValidAccessToken unless force is set', async () => {
    const getValidAccessToken = vi.fn(async () => 'tok');
    const onSilentRenew = vi.fn(async () => 'tok');
    getConfig.mockReturnValue({ getValidAccessToken, onSilentRenew } as never);
    await ensureFreshGithubToken();
    expect(getValidAccessToken).toHaveBeenCalledOnce();
    expect(onSilentRenew).not.toHaveBeenCalled();
  });

  it('calls onSilentRenew when force is set', async () => {
    const getValidAccessToken = vi.fn(async () => 'tok');
    const onSilentRenew = vi.fn(async () => 'tok');
    getConfig.mockReturnValue({ getValidAccessToken, onSilentRenew } as never);
    await ensureFreshGithubToken({ force: true });
    expect(onSilentRenew).toHaveBeenCalledOnce();
    expect(getValidAccessToken).not.toHaveBeenCalled();
  });
});

describe('githubOAuthDomains', () => {
  it('falls back to the credential helper domains when github is unregistered', () => {
    getConfig.mockReturnValue(undefined);
    expect(githubOAuthDomains()).toEqual(GITHUB_DOMAINS);
  });

  it('uses the provider domain list when registered', () => {
    getConfig.mockReturnValue({ oauthTokenDomains: ['ghe.example'] } as never);
    expect(githubOAuthDomains()).toEqual(['ghe.example']);
  });
});
