import { describe, it, expect } from 'vitest';
import {
  toPreviewUrl,
  isLikelyUrl,
  basename,
  dirname,
  joinPath,
  ensureWithinRoot,
  isSafeServeEntry,
  resolveServeEntryPath,
  resolveNodePackageBaseUrl,
  resolvePinnedPackageVersion,
} from '../../../src/shell/supplemental-commands/shared.js';

describe('toPreviewUrl', () => {
  it('returns localhost preview URL in non-extension environment', () => {
    const url = toPreviewUrl('/workspace/app/index.html');
    expect(url).toBe('http://localhost:5710/preview/workspace/app/index.html');
  });

  it('preserves full VFS path in the URL', () => {
    const url = toPreviewUrl('/workspace/deep/nested/path/file.css');
    expect(url).toContain('/preview/workspace/deep/nested/path/file.css');
  });

  it('handles root path', () => {
    const url = toPreviewUrl('/');
    expect(url).toBe('http://localhost:5710/preview/');
  });

  it('uses chrome.runtime.getURL in extension mode', () => {
    const savedChrome = (globalThis as any).chrome;
    (globalThis as any).chrome = {
      runtime: {
        id: 'test-ext-id',
        getURL: (path: string) => `chrome-extension://test-ext-id${path}`,
      },
    };

    const url = toPreviewUrl('/workspace/app/index.html');
    expect(url).toBe('chrome-extension://test-ext-id/preview/workspace/app/index.html');

    (globalThis as any).chrome = savedChrome;
  });
});

describe('isLikelyUrl', () => {
  it('detects http URLs', () => {
    expect(isLikelyUrl('http://example.com')).toBe(true);
  });

  it('detects https URLs', () => {
    expect(isLikelyUrl('https://example.com')).toBe(true);
  });

  it('detects about: URLs', () => {
    expect(isLikelyUrl('about:blank')).toBe(true);
  });

  it('rejects plain paths', () => {
    expect(isLikelyUrl('/workspace/file.html')).toBe(false);
  });

  it('rejects relative paths', () => {
    expect(isLikelyUrl('file.html')).toBe(false);
  });
});

describe('basename', () => {
  it('returns filename from path', () => {
    expect(basename('/workspace/file.txt')).toBe('file.txt');
  });

  it('handles root path', () => {
    expect(basename('/')).toBe('');
  });

  it('strips trailing slash', () => {
    expect(basename('/workspace/dir/')).toBe('dir');
  });
});

describe('dirname', () => {
  it('returns parent directory', () => {
    expect(dirname('/workspace/file.txt')).toBe('/workspace');
  });

  it('returns root for top-level files', () => {
    expect(dirname('/file.txt')).toBe('/');
  });
});

describe('joinPath', () => {
  it('joins root with child', () => {
    expect(joinPath('/', 'file.txt')).toBe('/file.txt');
  });

  it('joins nested path with child', () => {
    expect(joinPath('/workspace', 'file.txt')).toBe('/workspace/file.txt');
  });
});

describe('ensureWithinRoot', () => {
  it('returns true for path within root', () => {
    expect(ensureWithinRoot('/workspace', '/workspace/file.txt')).toBe(true);
  });

  it('returns true for exact root match', () => {
    expect(ensureWithinRoot('/workspace', '/workspace')).toBe(true);
  });

  it('returns false for path outside root', () => {
    expect(ensureWithinRoot('/workspace', '/other/file.txt')).toBe(false);
  });

  it('returns false for prefix-but-not-child', () => {
    expect(ensureWithinRoot('/workspace', '/workspace2/file.txt')).toBe(false);
  });
});

describe('isSafeServeEntry', () => {
  it('accepts simple filename', () => {
    expect(isSafeServeEntry('index.html')).toBe(true);
  });

  it('accepts subdirectory entry', () => {
    expect(isSafeServeEntry('pages/about.html')).toBe(true);
  });

  it('rejects parent traversal', () => {
    expect(isSafeServeEntry('../escape.html')).toBe(false);
  });

  it('rejects nested parent traversal', () => {
    expect(isSafeServeEntry('pages/../../escape.html')).toBe(false);
  });

  it('rejects absolute path', () => {
    expect(isSafeServeEntry('/etc/passwd')).toBe(false);
  });
});

describe('resolveServeEntryPath', () => {
  it('constructs entry path for absolute directory', () => {
    expect(resolveServeEntryPath('/workspace/my-app', 'index.html')).toBe(
      '/workspace/my-app/index.html'
    );
  });

  it('normalizes relative-looking nested paths to a VFS path', () => {
    expect(resolveServeEntryPath('workspace/my-app', 'index.html')).toBe(
      '/workspace/my-app/index.html'
    );
  });

  it('handles directory with trailing slash', () => {
    expect(resolveServeEntryPath('/workspace/my-app/', 'index.html')).toBe(
      '/workspace/my-app/index.html'
    );
  });

  it('handles custom entry file', () => {
    expect(resolveServeEntryPath('/html', 'hello.html')).toBe('/html/hello.html');
  });

  it('handles root directory', () => {
    expect(resolveServeEntryPath('/', 'index.html')).toBe('/index.html');
  });

  it('handles nested directories', () => {
    expect(resolveServeEntryPath('/workspace/my-app/pages', 'about.html')).toBe(
      '/workspace/my-app/pages/about.html'
    );
  });

  it('normalizes dot segments in the entry path', () => {
    expect(resolveServeEntryPath('/workspace/my-app', './index.html')).toBe(
      '/workspace/my-app/index.html'
    );
  });

  it('collapses repeated separators in the entry path', () => {
    expect(resolveServeEntryPath('/workspace/my-app', 'pages//about.html')).toBe(
      '/workspace/my-app/pages/about.html'
    );
  });
});

describe('resolveNodePackageBaseUrl', () => {
  it('resolves the sql.js package directory in node', () => {
    expect(
      resolveNodePackageBaseUrl(
        'sql.js/dist/sql-wasm.js',
        '../../../../../node_modules/sql.js/dist/'
      ).toString()
    ).toContain('/node_modules/sql.js/dist/');
  });

  it('resolves the pyodide package directory in node', () => {
    expect(
      resolveNodePackageBaseUrl('pyodide/pyodide.mjs', '../../../../../node_modules/pyodide/')
        .pathname
    ).toContain('/node_modules/pyodide/');
  });
});

describe('resolvePinnedPackageVersion', () => {
  it('rejects version ranges so CDN assets cannot drift from the npm loader', () => {
    expect(() => resolvePinnedPackageVersion('pyodide', '^0.29.3')).toThrow(
      'pyodide must use an exact semver version in package.json'
    );
  });
});
