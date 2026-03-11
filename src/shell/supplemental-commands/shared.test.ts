import { describe, it, expect } from 'vitest';
import { toPreviewUrl, isLikelyUrl, basename, dirname, joinPath, ensureWithinRoot } from './shared.js';

describe('toPreviewUrl', () => {
  it('returns localhost preview URL in non-extension environment', () => {
    const url = toPreviewUrl('/workspace/app/index.html');
    expect(url).toBe('http://localhost:3000/preview/workspace/app/index.html');
  });

  it('preserves full VFS path in the URL', () => {
    const url = toPreviewUrl('/workspace/deep/nested/path/file.css');
    expect(url).toContain('/preview/workspace/deep/nested/path/file.css');
  });

  it('handles root path', () => {
    const url = toPreviewUrl('/');
    expect(url).toBe('http://localhost:3000/preview/');
  });

  it('uses chrome.runtime.getURL in extension mode', () => {
    const savedChrome = (globalThis as any).chrome;
    (globalThis as any).chrome = {
      runtime: { id: 'test-ext-id', getURL: (path: string) => `chrome-extension://test-ext-id${path}` },
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
