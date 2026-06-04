import { describe, expect, it } from 'vitest';
import { buildPreviewUrl, previewBaseHost } from '../src/preview-url.js';

describe('previewBaseHost', () => {
  it('maps production worker hosts to preview.sliccy.ai', () => {
    expect(previewBaseHost('https://www.sliccy.ai')).toBe('preview.sliccy.ai');
    expect(previewBaseHost('https://sliccy.ai')).toBe('preview.sliccy.ai');
    expect(previewBaseHost('https://www.sliccy.ai/anything')).toBe('preview.sliccy.ai');
  });

  it('maps the staging workers.dev host to preview.staging.sliccy.ai', () => {
    expect(previewBaseHost('https://slicc-tray-hub-staging.minivelos.workers.dev')).toBe(
      'preview.staging.sliccy.ai'
    );
  });

  it('is case-insensitive on host', () => {
    expect(previewBaseHost('https://WWW.SLICCY.AI')).toBe('preview.sliccy.ai');
  });

  it('throws on an unmapped worker host (no silent fallback)', () => {
    expect(() => previewBaseHost('https://something-else.example.com')).toThrow(
      /No preview base configured/
    );
  });
});

describe('buildPreviewUrl', () => {
  it('builds the canonical URL for prod', () => {
    // Note: the path argument is a URL path on the preview origin, NOT a VFS
    // path. The mint URL has `/` (DO record carries entryPath separately);
    // subsequent asset fetches use root-relative paths like `/app.js`.
    expect(buildPreviewUrl('https://www.sliccy.ai', 'tray1.abc', '/')).toBe(
      'https://tray1.abc.preview.sliccy.ai/'
    );
    expect(buildPreviewUrl('https://www.sliccy.ai', 'tray1.abc', '/app.js')).toBe(
      'https://tray1.abc.preview.sliccy.ai/app.js'
    );
  });

  it('builds the staging URL even though the worker host is on workers.dev', () => {
    expect(
      buildPreviewUrl(
        'https://slicc-tray-hub-staging.minivelos.workers.dev',
        'tray2.def',
        '/app.js'
      )
    ).toBe('https://tray2.def.preview.staging.sliccy.ai/app.js');
  });

  it('defaults path to "/" when omitted', () => {
    expect(buildPreviewUrl('https://www.sliccy.ai', 'tray3.xyz')).toBe(
      'https://tray3.xyz.preview.sliccy.ai/'
    );
  });

  it('prepends "/" to path if missing', () => {
    expect(buildPreviewUrl('https://www.sliccy.ai', 'tray4.qrs', 'foo.html')).toBe(
      'https://tray4.qrs.preview.sliccy.ai/foo.html'
    );
  });
});
