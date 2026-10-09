import { readOAuthExtras } from '@slicc/shared-ts';
import { getRegisteredProviderConfig } from '../providers/index.js';
import { GITHUB_DOMAINS } from './github-domains.js';

export async function ensureFreshGithubToken(opts?: { force?: boolean }): Promise<void> {
  const github = getRegisteredProviderConfig('github');
  if (!github) return;
  if (opts?.force) {
    await github.onSilentRenew?.();
    return;
  }
  await github.getValidAccessToken?.();
}

export function githubOAuthDomains(): string[] {
  const github = getRegisteredProviderConfig('github');
  if (!github) return GITHUB_DOMAINS;
  const extras = typeof localStorage === 'undefined' ? [] : readOAuthExtras(localStorage).github;
  return [...(github.oauthTokenDomains ?? GITHUB_DOMAINS), ...(extras ?? [])];
}
