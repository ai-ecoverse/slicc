import { describe, expect, it, vi } from 'vitest';
import {
  GITHUB_RELEASES_MAX_PAGES,
  GITHUB_RELEASES_PER_PAGE,
  GithubReleasesHttpError,
  GithubReleasesParseError,
  SLICC_GITHUB_RELEASES_URL,
  scanGithubReleases,
} from '../src/github-releases.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function release(
  tag: string,
  assetNames: string[],
  extra: { draft?: boolean; prerelease?: boolean } = {}
) {
  return {
    tag_name: tag,
    draft: extra.draft,
    prerelease: extra.prerelease,
    assets: assetNames.map((name) => ({
      name,
      browser_download_url: `https://example.com/${tag}/${name}`,
    })),
  };
}

const byName = (wanted: string) => (asset: { name?: string }) => asset.name === wanted;

describe('scanGithubReleases', () => {
  it('paginates newest→oldest until the first matching asset', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse([release('v2', ['notes.txt']), release('v1', [])]))
      .mockResolvedValueOnce(jsonResponse([release('v0', ['slicc-cli'])]));

    const hit = await scanGithubReleases(fetchImpl, {
      userAgent: 'test-ua',
      perPage: 2,
      assetPredicate: byName('slicc-cli'),
    });

    expect(hit?.release.tag_name).toBe('v0');
    expect(hit?.asset.browser_download_url).toBe('https://example.com/v0/slicc-cli');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      `${SLICC_GITHUB_RELEASES_URL}?per_page=2&page=1`
    );
    expect(String(fetchImpl.mock.calls[1]?.[0])).toBe(
      `${SLICC_GITHUB_RELEASES_URL}?per_page=2&page=2`
    );
    expect((fetchImpl.mock.calls[0]?.[1] as RequestInit).headers).toEqual({
      'User-Agent': 'test-ua',
    });
  });

  it('stops at a short page instead of fetching further pages', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse([release('v1', ['notes.txt'])]));

    expect(
      await scanGithubReleases(fetchImpl, {
        userAgent: 'test-ua',
        perPage: 2,
        assetPredicate: byName('slicc-cli'),
      })
    ).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('stops on an empty page', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse([]));
    expect(
      await scanGithubReleases(fetchImpl, {
        userAgent: 'test-ua',
        assetPredicate: byName('slicc-cli'),
      })
    ).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('caps the walk at maxPages even when every page is full', async () => {
    const fullPage = [release('a', []), release('b', [])];
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse(fullPage));

    expect(
      await scanGithubReleases(fetchImpl, {
        userAgent: 'test-ua',
        perPage: 2,
        maxPages: 3,
        assetPredicate: byName('slicc-cli'),
      })
    ).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('defaults to GitHub max page size and a 5-page backstop', async () => {
    const fullPage = Array.from({ length: GITHUB_RELEASES_PER_PAGE }, (_, i) =>
      release(`v${i}`, [])
    );
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse(fullPage));

    expect(
      await scanGithubReleases(fetchImpl, {
        userAgent: 'test-ua',
        assetPredicate: byName('slicc-cli'),
      })
    ).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(GITHUB_RELEASES_MAX_PAGES);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain(`per_page=${GITHUB_RELEASES_PER_PAGE}`);
  });

  it('returns the first matching asset on the newest matching release', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse([
        {
          tag_name: 'v2',
          assets: [
            { name: 'slicc-cli', browser_download_url: 'https://example.com/first' },
            { name: 'slicc-cli', browser_download_url: 'https://example.com/second' },
          ],
        },
        {
          tag_name: 'v1',
          assets: [{ name: 'slicc-cli', browser_download_url: 'https://example.com/older' }],
        },
      ])
    );

    const hit = await scanGithubReleases(fetchImpl, {
      userAgent: 'test-ua',
      assetPredicate: byName('slicc-cli'),
    });
    expect(hit?.release.tag_name).toBe('v2');
    expect(hit?.asset.browser_download_url).toBe('https://example.com/first');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('surfaces a non-OK response as GithubReleasesHttpError', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ message: 'rate limited' }, 403));

    const rejection = scanGithubReleases(fetchImpl, {
      userAgent: 'test-ua',
      assetPredicate: byName('slicc-cli'),
    });
    await expect(rejection).rejects.toBeInstanceOf(GithubReleasesHttpError);
    await expect(rejection).rejects.toMatchObject({
      name: 'GithubReleasesHttpError',
      status: 403,
      page: 1,
    });
  });

  it('surfaces unparseable JSON as GithubReleasesParseError', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('<!doctype html>', { status: 200 }));

    await expect(
      scanGithubReleases(fetchImpl, {
        userAgent: 'test-ua',
        assetPredicate: byName('slicc-cli'),
      })
    ).rejects.toBeInstanceOf(GithubReleasesParseError);
  });

  it('stops without returning a later match when shouldStop fires', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse([release('v3', []), release('v2', []), release('v1', ['slicc-cli'])])
      );

    expect(
      await scanGithubReleases(fetchImpl, {
        userAgent: 'test-ua',
        assetPredicate: byName('slicc-cli'),
        shouldStop: (candidate) => candidate.tag_name === 'v2',
      })
    ).toBeNull();
  });

  it('forwards an AbortSignal on every page fetch', async () => {
    const signal = AbortSignal.timeout(30_000);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse([release('v1', ['slicc-cli'])]));

    await scanGithubReleases(fetchImpl, {
      userAgent: 'test-ua',
      assetPredicate: byName('slicc-cli'),
      signal,
    });
    expect((fetchImpl.mock.calls[0]?.[1] as RequestInit).signal).toBe(signal);
  });
});
