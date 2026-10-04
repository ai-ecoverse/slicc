/**
 * GitHub OAuth token freshness and domain list for git network ops.
 *
 * Lives next to `GitCommands`, not the shell: the cone's `git` and the
 * `git-credential-slicc` helper both need the same refresh + domain set,
 * and neither is a bash concern.
 */

import { readOAuthExtras } from '@slicc/shared-ts';
import { getRegisteredProviderConfig } from '../providers/index.js';
import { GITHUB_DOMAINS } from '../shell/supplemental-commands/git-credential-command.js';

/**
 * Best-effort GitHub auth refresh for git network ops.
 *
 * - Default: expiry-gated {@link ProviderConfig.getValidAccessToken}, which
 *   also re-syncs `/workspace/.git/github-token` from the live OAuth mask
 *   so a stale `git config github.token` snapshot cannot win (#2777).
 * - `force: true`: call {@link ProviderConfig.onSilentRenew} once (used by
 *   isomorphic-git `onAuthFailure` after a 401) so an access token that is
 *   still inside its local expiry window but rejected upstream can rotate.
 */
export async function ensureFreshGithubToken(opts?: { force?: boolean }): Promise<void> {
  const github = getRegisteredProviderConfig('github');
  if (!github) return;
  if (opts?.force) {
    await github.onSilentRenew?.();
    return;
  }
  await github.getValidAccessToken?.();
}

/**
 * Where the GitHub OAuth token is unmasked: the provider's domains plus the
 * user's extras, as the replica gets them (`saveOAuthAccount`).
 */
export function githubOAuthDomains(): string[] {
  const github = getRegisteredProviderConfig('github');
  if (!github) return GITHUB_DOMAINS;
  const extras = typeof localStorage === 'undefined' ? [] : readOAuthExtras(localStorage).github;
  return [...(github.oauthTokenDomains ?? GITHUB_DOMAINS), ...(extras ?? [])];
}
