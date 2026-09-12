/**
 * Bounded newest→oldest scan of GitHub's releases API for the first asset
 * matching a caller-supplied predicate.
 *
 * Pagination lives here so the worker DMG route, the worker CLI download
 * route, and node-server `--install-cli` cannot drift on page size or the
 * max-pages backstop (#3062). Callers keep only their asset predicate and
 * their own failure policy (302 fallback vs 502 vs throw).
 *
 * `GITHUB_RELEASES_PER_PAGE` is GitHub's documented maximum (`per_page=100`).
 * Five pages is a 500-release cap — enough to absorb sparse native-artifact
 * gaps at the current release cadence without walking the whole history on
 * every download hit. Do not reintroduce a smaller page size at a call site.
 */

/** GitHub's maximum `per_page` for `/repos/{owner}/{repo}/releases`. */
export const GITHUB_RELEASES_PER_PAGE = 100;

/** Absolute backstop so a binary-less streak cannot exhaust the rate limit. */
export const GITHUB_RELEASES_MAX_PAGES = 5;

export const SLICC_GITHUB_RELEASES_URL = 'https://api.github.com/repos/ai-ecoverse/slicc/releases';

export interface GithubReleaseAsset {
  name?: string;
  browser_download_url?: string;
}

export interface GithubRelease {
  draft?: boolean;
  prerelease?: boolean;
  tag_name?: string;
  assets?: GithubReleaseAsset[];
}

export interface GithubReleasesScanHit {
  release: GithubRelease;
  asset: GithubReleaseAsset;
}

/** Thrown when a page fetch returns a non-2xx status. Callers map this to 302 / 502 / throw. */
export class GithubReleasesHttpError extends Error {
  constructor(
    readonly status: number,
    readonly page: number
  ) {
    super(`GitHub releases API responded ${status} for page ${page}`);
    this.name = 'GithubReleasesHttpError';
  }
}

/** Thrown when a 2xx body is not JSON. Callers map this to 302 / 502 / throw. */
export class GithubReleasesParseError extends Error {
  constructor(
    readonly page: number,
    cause?: unknown
  ) {
    super('GitHub releases API returned unparseable JSON');
    this.name = 'GithubReleasesParseError';
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

/**
 * Extra `fetch` init merged into every page request. Worker call sites pass
 * Cloudflare `cf` cache hints; Node omits this. `headers` / `signal` on this
 * object lose to the helper's User-Agent and `options.signal`.
 */
export type GithubReleasesRequestInit = RequestInit & {
  /** Cloudflare Workers cache API. Ignored by Node `fetch`. */
  cf?: {
    cacheTtl?: number;
    cacheEverything?: boolean;
  };
};

export interface ScanGithubReleasesOptions {
  userAgent: string;
  assetPredicate: (asset: GithubReleaseAsset, release: GithubRelease) => boolean;
  /**
   * After `assetPredicate` misses on a release, return null without scanning
   * older releases (the DMG known-good pointer floor).
   */
  shouldStop?: (release: GithubRelease) => boolean;
  signal?: AbortSignal;
  requestInit?: GithubReleasesRequestInit;
  /**
   * Test-only overrides. Production callers omit these so every scan shares
   * `GITHUB_RELEASES_PER_PAGE` × `GITHUB_RELEASES_MAX_PAGES`.
   */
  perPage?: number;
  maxPages?: number;
}

/**
 * Walk releases newest→oldest until `assetPredicate` hits, a short/empty page,
 * `shouldStop`, or `maxPages`. Throws on `!res.ok` or unparseable JSON.
 */
export async function scanGithubReleases(
  fetchImpl: typeof fetch,
  options: ScanGithubReleasesOptions
): Promise<GithubReleasesScanHit | null> {
  const perPage = options.perPage ?? GITHUB_RELEASES_PER_PAGE;
  const maxPages = options.maxPages ?? GITHUB_RELEASES_MAX_PAGES;
  const { userAgent, assetPredicate, shouldStop, signal, requestInit } = options;

  for (let page = 1; page <= maxPages; page++) {
    const res = await fetchImpl(`${SLICC_GITHUB_RELEASES_URL}?per_page=${perPage}&page=${page}`, {
      ...requestInit,
      headers: { 'User-Agent': userAgent },
      signal,
    });
    if (!res.ok) {
      throw new GithubReleasesHttpError(res.status, page);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch (cause) {
      throw new GithubReleasesParseError(page, cause);
    }
    if (!Array.isArray(body) || body.length === 0) {
      return null;
    }
    for (const item of body) {
      const release = item as GithubRelease;
      const asset = release.assets?.find((candidate) => assetPredicate(candidate, release));
      if (asset) {
        return { release, asset };
      }
      if (shouldStop?.(release)) {
        return null;
      }
    }
    if (body.length < perPage) {
      return null;
    }
  }
  return null;
}
