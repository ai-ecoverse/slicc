import { describe, expect, it } from 'vitest';
import {
  buildCdnUrl,
  JSDELIVR_HOST,
  jsdelivrNpmUrl,
  REGISTRY_NPMJS_HOST,
  registryUrl,
  UNPKG_HOST,
  unpkgUrl,
  validateNpmPackageName,
} from '../../../src/shell/supplemental-commands/cdn-url-builder.js';

describe('cdn-url-builder host constants', () => {
  it('resolves the two surviving CDN hosts', () => {
    expect(UNPKG_HOST).toBe('unpkg.com');
    expect(JSDELIVR_HOST).toBe('cdn.jsdelivr.net');
  });

  it('does not export an esm.sh host or builder (Wave 6 removed the runtime resolver)', async () => {
    const mod = await import('../../../src/shell/supplemental-commands/cdn-url-builder.js');
    expect((mod as Record<string, unknown>)['ESM_SH_HOST']).toBeUndefined();
    expect((mod as Record<string, unknown>)['esmShUrl']).toBeUndefined();
  });

  it('resolves the npm registry host via the token-host pattern', () => {
    expect(REGISTRY_NPMJS_HOST).toBe('registry.npmjs.org');
  });
});

describe('registryUrl', () => {
  it('builds a packument URL for a plain package', () => {
    expect(registryUrl('lodash').toString()).toBe('https://registry.npmjs.org/lodash');
  });

  it('builds a packument URL for a scoped package', () => {
    expect(registryUrl('@scope/pkg').toString()).toBe('https://registry.npmjs.org/@scope/pkg');
  });

  it('appends a tarball sub-path when supplied', () => {
    expect(registryUrl('lodash', '/-/lodash-4.17.21.tgz').toString()).toBe(
      'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz'
    );
  });

  it('normalizes a sub-path missing its leading slash', () => {
    expect(registryUrl('lodash', '-/lodash-4.17.21.tgz').toString()).toBe(
      'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz'
    );
  });

  it('rejects a name that would change the URL host away from the registry', () => {
    expect(() => registryUrl('/evil')).toThrow(/invalid npm package name/i);
    expect(() => registryUrl('//evil.com')).toThrow(/invalid npm package name/i);
    expect(() => registryUrl('//evil.com/path')).toThrow(/invalid npm package name/i);
    expect(() => registryUrl('../escape')).toThrow(/invalid npm package name/i);
  });

  it('keeps the URL host pinned to the registry host for any legitimate name', () => {
    expect(registryUrl('lodash').host).toBe(REGISTRY_NPMJS_HOST);
    expect(registryUrl('@scope/pkg').host).toBe(REGISTRY_NPMJS_HOST);
    expect(registryUrl('JSONStream').host).toBe(REGISTRY_NPMJS_HOST);
  });
});

describe('validateNpmPackageName', () => {
  for (const valid of [
    'lodash',
    'is-number',
    'is_odd',
    '@scope/pkg',
    '@types/node',
    '@acme/util',
    'JSONStream',
    'a',
    'a.b.c',
    'a-b_c.d',
  ]) {
    it(`accepts a legitimate name ${JSON.stringify(valid)}`, () => {
      expect(() => validateNpmPackageName(valid)).not.toThrow();
    });
  }

  for (const invalid of [
    '',
    '/evil',
    '//evil.com',
    '//evil.com/path',
    '..',
    '../x',
    '../../etc/passwd',
    'foo/../bar',
    'foo/bar',
    '.hidden',
    '_private',
    'foo bar',
    'foo\tbar',
    'foo\u0000bar',
    '@',
    '@/',
    '@scope',
    '@/name',
    '@scope/with/extra',
    '@scope//name',
  ]) {
    it(`rejects invalid name ${JSON.stringify(invalid)}`, () => {
      expect(() => validateNpmPackageName(invalid)).toThrow(/invalid npm package name/i);
    });
  }

  it('rejects names longer than 214 characters', () => {
    expect(() => validateNpmPackageName('a'.repeat(215))).toThrow(/invalid npm package name/i);
  });
});

describe('buildCdnUrl', () => {
  it('returns a URL object scoped to the given host', () => {
    const url = buildCdnUrl(UNPKG_HOST, '/foo');
    expect(url).toBeInstanceOf(URL);
    expect(url.host).toBe('unpkg.com');
    expect(url.protocol).toBe('https:');
    expect(url.pathname).toBe('/foo');
  });

  it('preserves the leading slash on the path', () => {
    expect(buildCdnUrl(UNPKG_HOST, '/').toString()).toBe('https://unpkg.com/');
  });

  it('resolves an empty path to the host root with a trailing slash', () => {
    expect(buildCdnUrl(UNPKG_HOST, '').toString()).toBe('https://unpkg.com/');
  });
});

describe('unpkgUrl', () => {
  it('builds a versioned package + file URL', () => {
    expect(unpkgUrl('@ffmpeg/core', '0.12.10', 'dist/esm/').toString()).toBe(
      'https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm/'
    );
    expect(unpkgUrl('esbuild-wasm', '0.21.5', 'esbuild.wasm').toString()).toBe(
      'https://unpkg.com/esbuild-wasm@0.21.5/esbuild.wasm'
    );
  });

  it('omits the version segment when no version is supplied', () => {
    expect(unpkgUrl('lodash').toString()).toBe('https://unpkg.com/lodash');
  });

  it('omits the file segment when no file is supplied', () => {
    expect(unpkgUrl('@biomejs/wasm-web', '2.4.16').toString()).toBe(
      'https://unpkg.com/@biomejs/wasm-web@2.4.16'
    );
  });

  it('normalizes a leading slash on the file argument', () => {
    expect(unpkgUrl('foo', '1.0.0', '/bar.wasm').toString()).toBe(
      'https://unpkg.com/foo@1.0.0/bar.wasm'
    );
  });

  it('preserves a scoped package name including the leading @', () => {
    const url = unpkgUrl('@scope/pkg', '1.2.3');
    expect(url.pathname).toBe('/@scope/pkg@1.2.3');
  });
});

describe('jsdelivrNpmUrl', () => {
  it('builds an npm-scoped jsdelivr URL with a file path', () => {
    expect(jsdelivrNpmUrl('@imagemagick/magick-wasm', '0.0.38', 'dist/').toString()).toBe(
      'https://cdn.jsdelivr.net/npm/@imagemagick/magick-wasm@0.0.38/dist/'
    );
  });

  it('omits version + file when only the package is supplied', () => {
    expect(jsdelivrNpmUrl('lodash').toString()).toBe('https://cdn.jsdelivr.net/npm/lodash');
  });

  it('omits the file segment when no file is supplied', () => {
    expect(jsdelivrNpmUrl('lodash', '4.17.21').toString()).toBe(
      'https://cdn.jsdelivr.net/npm/lodash@4.17.21'
    );
  });

  it('normalizes a leading slash on the file argument', () => {
    expect(jsdelivrNpmUrl('lodash', '4.17.21', '/index.js').toString()).toBe(
      'https://cdn.jsdelivr.net/npm/lodash@4.17.21/index.js'
    );
  });
});
