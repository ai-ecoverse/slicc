import type { SecureFetch, SecureFetchOptions } from 'just-bash';

type FetchResult = Awaited<ReturnType<SecureFetch>>;

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchPackument,
  fetchTarball,
  type Packument,
  REGISTRY_NPMJS_HOST,
  registryUrl,
  resolveVersion,
} from '../../../src/shell/ipk/registry.js';

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function jsonResult(body: unknown, status = 200, statusText = 'OK'): FetchResult {
  return {
    status,
    statusText,
    headers: { 'content-type': 'application/json' },
    body: bytes(JSON.stringify(body)),
    url: 'mock://json',
  };
}

function binaryResult(body: Uint8Array, status = 200, statusText = 'OK'): FetchResult {
  return {
    status,
    statusText,
    headers: { 'content-type': 'application/octet-stream' },
    body,
    url: 'mock://binary',
  };
}

function makePackument(
  name: string,
  versions: string[],
  distTags?: Record<string, string>
): Packument {
  const versionMap: Record<string, { name: string; version: string; dist: { tarball: string } }> =
    {};
  for (const v of versions) {
    versionMap[v] = {
      name,
      version: v,
      dist: { tarball: `https://${REGISTRY_NPMJS_HOST}/${name}/-/${name}-${v}.tgz` },
    };
  }
  const tags: Record<string, string> = distTags ?? { latest: versions[versions.length - 1] };
  return {
    name,
    'dist-tags': tags,
    versions: versionMap,
  } as Packument;
}

describe('registryUrl', () => {
  it('builds a registry URL with the registry.npmjs.org host', () => {
    const url = registryUrl('lodash');
    expect(url).toBeInstanceOf(URL);
    expect(url.host).toBe('registry.npmjs.org');
    expect(url.protocol).toBe('https:');
    expect(url.pathname).toBe('/lodash');
  });

  it('preserves scoped package names', () => {
    const url = registryUrl('@scope/pkg');
    expect(url.pathname).toBe('/@scope/pkg');
  });
});

describe('REGISTRY_NPMJS_HOST', () => {
  it('resolves the npm registry hostname', () => {
    expect(REGISTRY_NPMJS_HOST).toBe('registry.npmjs.org');
  });
});

describe('fetchPackument', () => {
  let abortMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    abortMock = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('GETs the packument from the registry host and parses JSON', async () => {
    const packument = makePackument('is-number', ['7.0.0']);
    const fetchMock = vi.fn(
      async (url: string, opts?: SecureFetchOptions): Promise<FetchResult> => {
        abortMock(url, opts);
        return jsonResult(packument);
      }
    ) as unknown as SecureFetch;

    const result = await fetchPackument('is-number', fetchMock);
    expect(result.name).toBe('is-number');
    expect(result.versions['7.0.0']).toBeDefined();

    expect(abortMock).toHaveBeenCalledOnce();
    const calledUrl = abortMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain('registry.npmjs.org');
    expect(calledUrl).toContain('/is-number');
    expect((abortMock.mock.calls[0][1] as SecureFetchOptions)?.method ?? 'GET').toBe('GET');
  });

  it('encodes scoped packages in the URL path', async () => {
    const packument = makePackument('@scope/pkg', ['1.0.0']);
    const calls: string[] = [];
    const fetchMock = (async (url: string) => {
      calls.push(url);
      return jsonResult(packument);
    }) as unknown as SecureFetch;

    await fetchPackument('@scope/pkg', fetchMock);
    expect(calls[0]).toContain('/@scope/pkg');
  });

  it('rejects with a clear error on non-2xx HTTP status', async () => {
    const fetchMock = (async () =>
      ({
        status: 404,
        statusText: 'Not Found',
        headers: {},
        body: bytes('not found'),
        url: 'mock://404',
      }) satisfies FetchResult) as unknown as SecureFetch;

    await expect(fetchPackument('nope', fetchMock)).rejects.toThrow(/404/);
  });

  it('rejects with a clear error on malformed JSON', async () => {
    const fetchMock = (async () =>
      ({
        status: 200,
        statusText: 'OK',
        headers: {},
        body: bytes('not json'),
        url: 'mock://bad',
      }) satisfies FetchResult) as unknown as SecureFetch;

    await expect(fetchPackument('bad-json', fetchMock)).rejects.toThrow(/JSON|valid|parse/i);
  });

  it('rejects with a clear error when packument is missing versions', async () => {
    const fetchMock = (async () => jsonResult({ name: 'broken' })) as unknown as SecureFetch;

    await expect(fetchPackument('broken', fetchMock)).rejects.toThrow(/versions/);
  });

  it('rejects with a clear error when the package name is empty', async () => {
    const fetchMock = vi.fn() as unknown as SecureFetch;
    await expect(fetchPackument('', fetchMock)).rejects.toThrow(/package name|name/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('times out and rejects with a clear error if SecureFetch never resolves', async () => {
    const fetchMock = (() => new Promise<FetchResult>(() => {})) as unknown as SecureFetch;
    await expect(fetchPackument('hangs', fetchMock, { timeoutMs: 10 })).rejects.toThrow(
      /time(d)? out/i
    );
  });

  it('passes the requested timeoutMs to SecureFetch options', async () => {
    const seen: SecureFetchOptions[] = [];
    const fetchMock = (async (_url: string, opts?: SecureFetchOptions) => {
      if (opts) seen.push(opts);
      return jsonResult(makePackument('a', ['1.0.0']));
    }) as unknown as SecureFetch;

    await fetchPackument('a', fetchMock, { timeoutMs: 5000 });
    expect(seen[0]?.timeoutMs).toBe(5000);
  });
});

describe('resolveVersion', () => {
  const packument = makePackument('p', ['1.0.0', '1.2.0', '1.2.3', '2.0.0', '3.0.0-beta.1'], {
    latest: '2.0.0',
    next: '3.0.0-beta.1',
  });

  it('resolves an exact version that exists in the packument', () => {
    expect(resolveVersion(packument, '1.2.0')).toBe('1.2.0');
  });

  it('resolves a caret range to the highest in-range version', () => {
    expect(resolveVersion(packument, '^1.0.0')).toBe('1.2.3');
  });

  it('resolves a tilde range to the highest matching patch', () => {
    expect(resolveVersion(packument, '~1.2.0')).toBe('1.2.3');
  });

  it('resolves wildcard "*" to the highest stable version', () => {
    expect(resolveVersion(packument, '*')).toBe('2.0.0');
  });

  it('resolves an empty range to the latest dist-tag', () => {
    expect(resolveVersion(packument, '')).toBe('2.0.0');
  });

  it('resolves the "latest" dist-tag explicitly', () => {
    expect(resolveVersion(packument, 'latest')).toBe('2.0.0');
  });

  it('resolves a named dist-tag (e.g. "next")', () => {
    expect(resolveVersion(packument, 'next')).toBe('3.0.0-beta.1');
  });

  it('throws clearly on an unsatisfiable range', () => {
    expect(() => resolveVersion(packument, '^5.0.0')).toThrow(/no version satisfies/i);
  });

  it('throws clearly on an unknown dist-tag that is also not a valid range', () => {
    expect(() => resolveVersion(packument, 'definitely-not-a-tag')).toThrow();
  });

  it('throws when the packument contains no versions', () => {
    const empty = { name: 'empty', versions: {} } as Packument;
    expect(() => resolveVersion(empty, '*')).toThrow(/no versions/i);
  });

  it('throws when a dist-tag points at a missing version', () => {
    const broken: Packument = {
      name: 'broken',
      'dist-tags': { latest: '9.9.9' },
      versions: { '1.0.0': { name: 'broken', version: '1.0.0', dist: { tarball: 'mock://x' } } },
    };
    expect(() => resolveVersion(broken, 'latest')).toThrow();
  });
});

describe('fetchTarball', () => {
  it('GETs the tarball URL via the injected SecureFetch and returns Uint8Array bytes', async () => {
    const tarBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const calls: { url: string; opts?: SecureFetchOptions }[] = [];
    const fetchMock = (async (url: string, opts?: SecureFetchOptions) => {
      calls.push({ url, opts });
      return binaryResult(tarBytes);
    }) as unknown as SecureFetch;

    const out = await fetchTarball(`https://${REGISTRY_NPMJS_HOST}/p/-/p-1.0.0.tgz`, fetchMock);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(Array.from(out)).toEqual(Array.from(tarBytes));
    expect(calls[0].url).toContain('.tgz');
  });

  it('rejects with a clear error on non-2xx HTTP status', async () => {
    const fetchMock = (async () =>
      ({
        status: 500,
        statusText: 'Server Error',
        headers: {},
        body: new Uint8Array(),
        url: 'mock://500',
      }) satisfies FetchResult) as unknown as SecureFetch;

    await expect(fetchTarball('mock://500', fetchMock)).rejects.toThrow(/500|Server Error/);
  });

  it('rejects with a clear error when the body is empty', async () => {
    const fetchMock = (async () => binaryResult(new Uint8Array())) as unknown as SecureFetch;
    await expect(fetchTarball('mock://empty', fetchMock)).rejects.toThrow(/empty/i);
  });

  it('rejects with a clear error when url is empty', async () => {
    const fetchMock = vi.fn() as unknown as SecureFetch;
    await expect(fetchTarball('', fetchMock)).rejects.toThrow(/url/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('times out if SecureFetch never resolves', async () => {
    const fetchMock = (() => new Promise<FetchResult>(() => {})) as unknown as SecureFetch;
    await expect(fetchTarball('mock://hangs', fetchMock, { timeoutMs: 10 })).rejects.toThrow(
      /time(d)? out/i
    );
  });

  it('coerces a string body into Uint8Array bytes', async () => {
    const fetchMock = (async () =>
      ({
        status: 200,
        statusText: 'OK',
        headers: {},
        body: 'abc' as unknown as Uint8Array,
        url: 'mock://str',
      }) satisfies FetchResult) as unknown as SecureFetch;

    const out = await fetchTarball('mock://str', fetchMock);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.length).toBeGreaterThan(0);
  });
});
