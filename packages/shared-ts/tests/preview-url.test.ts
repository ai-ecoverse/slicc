import { describe, expect, it } from 'vitest';
import { buildPreviewUrl, previewBaseHost } from '../src/preview-url.js';

describe('previewBaseHost', () => {
  it('maps production worker hosts to sliccy.now', () => {
    expect(previewBaseHost('https://www.sliccy.ai')).toBe('sliccy.now');
    expect(previewBaseHost('https://sliccy.ai')).toBe('sliccy.now');
    expect(previewBaseHost('https://www.sliccy.ai/anything')).toBe('sliccy.now');
  });

  it('maps the staging workers.dev host to sliccy.dev', () => {
    expect(previewBaseHost('https://slicc-tray-hub-staging.minivelos.workers.dev')).toBe(
      'sliccy.dev'
    );
  });

  it('is case-insensitive on host', () => {
    expect(previewBaseHost('https://WWW.SLICCY.AI')).toBe('sliccy.now');
  });

  it('throws on an unmapped worker host (no silent fallback)', () => {
    expect(() => previewBaseHost('https://something-else.example.com')).toThrow(
      /No preview base configured/
    );
  });
});

describe('buildPreviewUrl', () => {
  it('builds URL with compact UUID (hyphens stripped) in subdomain — old format without userHash', () => {
    expect(
      buildPreviewUrl('https://www.sliccy.ai', 'abcd1234-0000-0000-0000-000000000001.ff', '/')
    ).toBe('https://abcd1234000000000000000000000001--ff.sliccy.now/');
  });

  it('builds the staging URL — old format', () => {
    expect(
      buildPreviewUrl(
        'https://slicc-tray-hub-staging.minivelos.workers.dev',
        'abcd1234-0000-0000-0000-000000000002.def',
        '/app.js'
      )
    ).toBe('https://abcd1234000000000000000000000002--def.sliccy.dev/app.js');
  });

  it('defaults path to "/" when omitted', () => {
    expect(
      buildPreviewUrl('https://www.sliccy.ai', 'abcd1234-0000-0000-0000-000000000003.xyz')
    ).toBe('https://abcd1234000000000000000000000003--xyz.sliccy.now/');
  });

  it('prepends "/" to path if missing', () => {
    expect(
      buildPreviewUrl(
        'https://www.sliccy.ai',
        'abcd1234-0000-0000-0000-000000000004.qrs',
        'foo.html'
      )
    ).toBe('https://abcd1234000000000000000000000004--qrs.sliccy.now/foo.html');
  });

  it('uses http for localhost dev', () => {
    expect(
      buildPreviewUrl('http://localhost:8787', 'abcd1234-0000-0000-0000-000000000005.abc', '/')
    ).toBe('http://abcd1234000000000000000000000005--abc.localhost:8787/');
  });

  // New format: <compactUUID>--<userHash8>-<secret20>
  it('embeds userHash before secret when provided', () => {
    expect(
      buildPreviewUrl(
        'https://www.sliccy.ai',
        'abcd1234-0000-0000-0000-000000000001.ff00112233445566778899aa',
        '/',
        'ab12cd34'
      )
    ).toBe(
      'https://abcd1234000000000000000000000001--ab12cd34-ff00112233445566778899aa.sliccy.now/'
    );
  });

  it('embeds userHash in staging URL', () => {
    expect(
      buildPreviewUrl(
        'https://slicc-tray-hub-staging.minivelos.workers.dev',
        'abcd1234-0000-0000-0000-000000000002.aabbccddeeff00112233',
        '/app.js',
        'deadbeef'
      )
    ).toBe(
      'https://abcd1234000000000000000000000002--deadbeef-aabbccddeeff00112233.sliccy.dev/app.js'
    );
  });

  it('anonymous hash (00000000) embeds correctly', () => {
    expect(
      buildPreviewUrl(
        'https://www.sliccy.ai',
        'abcd1234-0000-0000-0000-000000000001.ff00112233445566778899aa',
        '/',
        '00000000'
      )
    ).toBe(
      'https://abcd1234000000000000000000000001--00000000-ff00112233445566778899aa.sliccy.now/'
    );
  });
});
