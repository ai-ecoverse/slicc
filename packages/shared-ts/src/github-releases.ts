export const GITHUB_RELEASES_PER_PAGE = 100;

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

export class GithubReleasesHttpError extends Error {
  constructor(
    readonly status: number,
    readonly page: number
  ) {
    super(`GitHub releases API responded ${status} for page ${page}`);
    this.name = 'GithubReleasesHttpError';
  }
}

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

export type GithubReleasesRequestInit = RequestInit & {
  cf?: {
    cacheTtl?: number;
    cacheEverything?: boolean;
  };
};

export interface ScanGithubReleasesOptions {
  userAgent: string;
  assetPredicate: (asset: GithubReleaseAsset, release: GithubRelease) => boolean;

  shouldStop?: (release: GithubRelease) => boolean;
  signal?: AbortSignal;
  requestInit?: GithubReleasesRequestInit;

  perPage?: number;
  maxPages?: number;
}

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
