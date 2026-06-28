/**
 * upskill — GitHub failure formatting.
 *
 * Extracted verbatim from `upskill-command.ts`. Turns a GitHub API response
 * into an actionable error message (rate-limit / auth / not-found guidance).
 * `describeFetchError` lives in `../fetch-error.js` — do not recreate it here.
 */

import { decodeFetchBody } from '../../../fetch-body.js';
import type { GitHubFetchResponse } from '../types.js';
import { getHeader } from './github-auth.js';

interface GitHubErrorBody {
  message?: string;
  documentation_url?: string;
}

export function getGitHubErrorDetail(body: Uint8Array | string): string | undefined {
  const text = decodeFetchBody(body);
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as GitHubErrorBody;
    if (typeof parsed.message === 'string' && parsed.message.trim()) {
      return parsed.message.trim();
    }
  } catch {
    // Not JSON — fall back to a trimmed text preview.
  }

  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, 200);
}

export function formatGitHubFailure(
  response: GitHubFetchResponse,
  resourceLabel: string,
  hasToken: boolean
): string {
  const detail = getGitHubErrorDetail(response.body);
  const detailSuffix = detail ? ` GitHub said: ${detail}` : '';
  const retryAfter = getHeader(response.headers, 'retry-after');
  const rateLimitRemaining = getHeader(response.headers, 'x-ratelimit-remaining');
  const normalizedDetail = detail?.toLowerCase() ?? '';
  const isRateLimit =
    response.status === 429 ||
    rateLimitRemaining === '0' ||
    normalizedDetail.includes('rate limit');

  if (isRateLimit) {
    if (hasToken) {
      return `GitHub rate-limited access to ${resourceLabel} (HTTP ${response.status}). The configured github.token was used, so retry later${retryAfter ? ` after about ${retryAfter} seconds` : ''}.${detailSuffix}`;
    }
    return `GitHub rate-limited anonymous access to ${resourceLabel} (HTTP ${response.status}). This often happens on shared VPNs or corporate egress IPs because unauthenticated GitHub API requests are limited per IP. Configure a token with: git config github.token <PAT>, then retry. You can also retry off VPN or later.${detailSuffix}`;
  }

  if (response.status === 401) {
    if (hasToken) {
      return `GitHub rejected the configured github.token while accessing ${resourceLabel} (HTTP 401). Update it with: git config github.token <PAT>, then retry.${detailSuffix}`;
    }
    return `GitHub requires authentication to access ${resourceLabel} (HTTP 401). Configure a token with: git config github.token <PAT>, then retry.${detailSuffix}`;
  }

  if (response.status === 404) {
    return `GitHub could not find ${resourceLabel} (HTTP 404). Check the repository, path, and permissions.${detailSuffix}`;
  }

  if (response.status === 403) {
    if (hasToken) {
      return `GitHub denied access to ${resourceLabel} (HTTP 403). Check that your github.token can access this repository or retry later if GitHub is throttling requests.${detailSuffix}`;
    }
    return `GitHub denied anonymous access to ${resourceLabel} (HTTP 403). If this repo is public on a shared VPN, you may have hit GitHub's shared IP limit; otherwise the repository or path may require authentication. Configure a token with: git config github.token <PAT>, then retry.${detailSuffix}`;
  }

  const statusDetail = response.statusText ? ` ${response.statusText}` : '';
  return `GitHub request for ${resourceLabel} failed (HTTP ${response.status}${statusDetail}).${detailSuffix}`;
}
