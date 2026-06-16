import { describe, expect, it } from 'vitest';
import {
  buildCdnUrl,
  ESM_SH_HOST,
  esmShUrl,
  JSDELIVR_HOST,
  jsdelivrNpmUrl,
  REGISTRY_NPMJS_HOST,
  registryUrl,
  UNPKG_HOST,
  unpkgUrl,
} from '../../../src/shell/supplemental-commands/cdn-url-builder.js';

describe('cdn-url-builder host constants', () => {
  it('resolves the three CDN hosts', () => {
    expect(UNPKG_HOST).toBe('unpkg.com');
    expect(ESM_SH_HOST).toBe('esm.sh');
    expect(JSDELIVR_HOST).toBe('cdn.jsdelivr.net');
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
    expect(buildCdnUrl(ESM_SH_HOST, '/').toString()).toBe('https://esm.sh/');
  });

  it('resolves an empty path to the host root with a trailing slash', () => {
    expect(buildCdnUrl(ESM_SH_HOST, '').toString()).toBe('https://esm.sh/');
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

describe('esmShUrl', () => {
  it('builds a bare-specifier URL', () => {
    expect(esmShUrl('react').toString()).toBe('https://esm.sh/react');
  });

  it('preserves subpath specifiers verbatim', () => {
    expect(esmShUrl('lodash/fp').toString()).toBe('https://esm.sh/lodash/fp');
  });

  it('preserves version-pinned specifiers verbatim', () => {
    expect(esmShUrl('react@18.2.0').toString()).toBe('https://esm.sh/react@18.2.0');
  });

  it('appends a bare ?bundle flag (no value)', () => {
    const url = esmShUrl('react', { bundle: true });
    expect(url.toString()).toBe('https://esm.sh/react?bundle');
    expect(url.search).toBe('?bundle');
  });

  it('appends ?target=<value>', () => {
    expect(esmShUrl('react', { target: 'es2020' }).toString()).toBe(
      'https://esm.sh/react?target=es2020'
    );
  });

  it('encodes special characters in a target value', () => {
    expect(esmShUrl('react', { target: 'chrome 100' }).search).toBe('?target=chrome%20100');
  });

  it('combines bundle, target, and arbitrary query options', () => {
    const url = esmShUrl('react', {
      bundle: true,
      target: 'es2020',
      query: { dev: true, deps: 'react@18' },
    });
    // Order matches insertion order: bundle, target, then query.
    expect(url.search).toBe('?bundle&target=es2020&dev&deps=react%4018');
  });

  it('accepts a path that already starts with a slash', () => {
    expect(esmShUrl('/react').toString()).toBe('https://esm.sh/react');
  });

  it('encodes path components through the URL constructor', () => {
    // Spaces in a specifier are URL-encoded by the standard URL parser.
    expect(esmShUrl('foo bar').toString()).toBe('https://esm.sh/foo%20bar');
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
