/**
 * upskill — GitHub auth: token load, header builder, request context, and the
 * global-fs cache backing the configured `github.token` lookup.
 *
 * Extracted verbatim from `upskill-command.ts`. All network I/O routes through
 * the injected `fetch: SecureFetch` so requests use the proxy in CLI mode and
 * direct fetch (CORS-bypassed) in the extension.
 */

import type { SecureFetch } from 'just-bash';
import type { VirtualFS } from '../../../../fs/index.js';
import { VirtualFS as SharedVirtualFS } from '../../../../fs/index.js';
import { describeFetchError } from '../fetch-error.js';
import type { GitHubRequestContext } from '../types.js';
import { GITHUB_API_ACCEPT, GITHUB_GLOBAL_DB, GITHUB_TOKEN_PATH } from '../types.js';

let cachedGlobalFsPromise: Promise<VirtualFS> | undefined;

export function getGlobalFs(): Promise<VirtualFS> {
  if (!cachedGlobalFsPromise) {
    cachedGlobalFsPromise = SharedVirtualFS.create({ dbName: GITHUB_GLOBAL_DB });
  }
  return cachedGlobalFsPromise;
}

/** @internal Exported only for test cleanup. */
export function _resetGlobalFsCache(): void {
  const pending = cachedGlobalFsPromise;
  cachedGlobalFsPromise = undefined;
  if (!pending) return;
  // Fire-and-forget dispose so the cached VirtualFS releases its
  // LightningFS lock (held via navigator.locks). Without this, the
  // dangling lock request rejects with AbortError on process teardown
  // and surfaces as an unhandled rejection in tests. Errors during
  // dispose are intentionally swallowed — this path runs from test
  // teardown and hot-reload where surfacing a cleanup rejection
  // produces false failures.
  pending.then(
    (vfs) => {
      void vfs.dispose().catch(() => {});
    },
    () => {}
  );
}

export async function loadConfiguredGitHubToken(): Promise<string | undefined> {
  try {
    const globalFs = await getGlobalFs();
    const token = (await globalFs.readTextFile(GITHUB_TOKEN_PATH)).trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}

export function buildGitHubHeaders(
  token?: string,
  accept: string = GITHUB_API_ACCEPT
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: accept,
    'User-Agent': 'slicc-upskill',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

export async function createGitHubRequestContext(
  fetch: SecureFetch
): Promise<GitHubRequestContext> {
  const token = await loadConfiguredGitHubToken();
  return {
    hasToken: Boolean(token),
    request: async (url: string, accept: string = GITHUB_API_ACCEPT) => {
      try {
        return await fetch(url, {
          headers: buildGitHubHeaders(token, accept),
        });
      } catch (err) {
        throw new Error(describeFetchError(err, url));
      }
    },
  };
}

export function getHeader(
  headers: Record<string, string> | undefined,
  name: string
): string | undefined {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}
