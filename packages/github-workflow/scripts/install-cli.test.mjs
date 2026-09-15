import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setup } from '../tests/helpers.mjs';
import { download, main, RELEASES_URL, resolveRelease } from './install-cli.mjs';

const BINARY = '#!/bin/sh\necho "slicc v9.9.9-fake"\n';

function release(tag, assets, extra = {}) {
  return {
    tag_name: tag,
    assets: assets.map((name) => ({ name, browser_download_url: `https://dl/${tag}/${name}` })),
    ...extra,
  };
}

/** Fake GitHub: `pages` is the paged release list; tags maps tag → release. */
function fakeFetch({ pages = [], tags = {}, downloadStatus = 200, seen = [] } = {}) {
  return async (url, init) => {
    seen.push({ url, auth: init?.headers?.authorization ?? null });
    const u = new URL(url);
    if (u.pathname.endsWith('/releases')) {
      const page = Number(u.searchParams.get('page'));
      const body = pages[page - 1] ?? [];
      return { ok: true, status: 200, json: async () => body };
    }
    if (u.pathname.includes('/releases/tags/')) {
      const tag = decodeURIComponent(u.pathname.split('/').pop());
      const r = tags[tag];
      return r ? { ok: true, status: 200, json: async () => r } : { ok: false, status: 404 };
    }
    if (u.hostname === 'dl') {
      return {
        ok: downloadStatus === 200,
        status: downloadStatus,
        arrayBuffer: async () => Buffer.from(BINARY),
      };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
}

describe('install-cli', () => {
  let t;
  beforeEach(() => {
    t = setup();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    t.teardown();
    vi.restoreAllMocks();
  });

  it('walks releases newest→oldest for the first carrier and installs it', async () => {
    const seen = [];
    const pages = [
      [release('v3', ['other']), release('v2', ['slicc-linux-amd64'], { prerelease: true })],
      [release('v1', ['slicc-linux-amd64'])],
    ];
    // page 1 must be "full" for the scan to continue: pad it to 100 entries
    while (pages[0].length < 100) pages[0].push(release('vx', []));
    t.inputs({ token: 'tok', version: 'latest', telemetry: 'false' });
    const r = await main({
      fetchImpl: fakeFetch({ pages, seen }),
      platform: 'linux',
      arch: 'x64',
    });
    expect(r.version).toBe('v1');
    expect(r.binary).toBe(join(t.home, 'cli', 'slicc'));
    expect(statSync(r.binary).mode & 0o111).not.toBe(0);
    expect(seen[0].auth).toBe('Bearer tok');
    expect(seen.map((s) => s.url)).toEqual([
      `${RELEASES_URL}?per_page=100&page=1`,
      `${RELEASES_URL}?per_page=100&page=2`,
      'https://dl/v1/slicc-linux-amd64',
    ]);
    const out = t.outputs();
    expect(out.path).toBe(r.binary);
    expect(out.version).toBe('v1');
    expect(t.envFile()).toEqual({
      SLICC_CLI: r.binary,
      SLICC_NO_UPDATE_CHECK: '1',
      SLICC_NO_TELEMETRY: '1',
    });
  });

  it('pins a release tag, keeps telemetry on when asked, and honours install-dir', async () => {
    t.inputs({ version: '6.150.4', telemetry: 'true', 'install-dir': join(t.root, 'bin') });
    const r = await main({
      fetchImpl: fakeFetch({ tags: { 'v6.150.4': release('v6.150.4', ['slicc-darwin-arm64']) } }),
      platform: 'darwin',
      arch: 'arm64',
    });
    expect(r.version).toBe('v6.150.4');
    expect(r.binary).toBe(join(t.root, 'bin', 'slicc'));
    expect(t.envFile().SLICC_NO_TELEMETRY).toBeUndefined();
  });

  it('errors clearly on unsupported platforms, missing carriers, and bad responses', async () => {
    await expect(
      main({ fetchImpl: fakeFetch(), platform: 'freebsd', arch: 'x64' })
    ).rejects.toThrow(/no slicc CLI build/);
    t.inputs({ version: 'latest' });
    await expect(
      main({
        fetchImpl: fakeFetch({ pages: [[release('v1', [])]] }),
        platform: 'linux',
        arch: 'x64',
      })
    ).rejects.toThrow(/no published release with a slicc-linux-amd64/);
    t.inputs({ version: 'v7' });
    await expect(
      main({
        fetchImpl: fakeFetch({ tags: { v7: release('v7', ['nope']) } }),
        platform: 'linux',
        arch: 'x64',
      })
    ).rejects.toThrow(/carries no slicc-linux-amd64/);
    await expect(resolveRelease('v8', 'slicc-linux-amd64', '', fakeFetch())).rejects.toThrow(
      /GitHub API 404/
    );
    await expect(
      download('https://dl/v1/x', '', join(t.root, 'x'), fakeFetch({ downloadStatus: 500 }))
    ).rejects.toThrow(/download 500/);
    expect(existsSync(join(t.root, 'x'))).toBe(false);
  });

  it('names the windows binary with .exe', async () => {
    t.inputs({ version: 'latest' });
    const exec = vi.fn(() => 'slicc v1');
    const r = await main({
      fetchImpl: fakeFetch({ pages: [[release('v1', ['slicc-windows-amd64.exe'])]] }),
      platform: 'win32',
      arch: 'x64',
      exec,
    });
    expect(r.binary).toBe(join(t.home, 'cli', 'slicc.exe'));
    expect(exec).toHaveBeenCalledWith(r.binary, ['--version'], { encoding: 'utf8' });
  });
});
