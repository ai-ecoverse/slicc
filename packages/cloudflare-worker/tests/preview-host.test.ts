import { describe, expect, it } from 'vitest';
import { previewTokenFromHost } from '../src/preview-host.js';

describe('previewTokenFromHost', () => {
  it('extracts and rehyphenates the UUID from a prod preview host', () => {
    // Subdomain has compact UUID (no hyphens) + '--' + secret
    expect(previewTokenFromHost('550e8400e29b41d4a716446655440000--deadbeef.sliccy.now')).toBe(
      '550e8400-e29b-41d4-a716-446655440000.deadbeef'
    );
  });

  it('extracts the full token from a staging preview host (sliccy.dev)', () => {
    expect(
      previewTokenFromHost('1ed1735cdce743d89e883a547d5deb5a--f67ad751feb0ad34.sliccy.dev')
    ).toBe('1ed1735c-dce7-43d8-9e88-3a547d5deb5a.f67ad751feb0ad34');
  });

  it('is case-insensitive on the suffix', () => {
    expect(previewTokenFromHost('550e8400e29b41d4a716446655440000--abcd1234.SLICCY.NOW')).toBe(
      '550e8400-e29b-41d4-a716-446655440000.abcd1234'
    );
  });

  it('returns null for non-preview hosts', () => {
    expect(previewTokenFromHost('www.sliccy.ai')).toBeNull();
    expect(previewTokenFromHost('example.com')).toBeNull();
    expect(previewTokenFromHost('sliccy.now')).toBeNull();
  });

  it('returns null for malformed hosts', () => {
    expect(previewTokenFromHost('')).toBeNull();
    expect(previewTokenFromHost('notoken.sliccy.now')).toBeNull(); // missing --
    expect(previewTokenFromHost('short--abc.sliccy.now')).toBeNull(); // UUID part not 32 chars
  });

  it('extracts the token from a localhost dev host (with and without a port)', () => {
    // Matches the `localhost:8787` row in buildPreviewUrl so `serve --bridge`
    // is testable against a single local `wrangler dev` with no deploy.
    expect(previewTokenFromHost('1ed1735cdce743d89e883a547d5deb5a--f67ad751.localhost:8787')).toBe(
      '1ed1735c-dce7-43d8-9e88-3a547d5deb5a.f67ad751'
    );
    expect(previewTokenFromHost('550e8400e29b41d4a716446655440000--abcd1234.localhost')).toBe(
      '550e8400-e29b-41d4-a716-446655440000.abcd1234'
    );
  });

  it('does not match a non-terminal localhost label (anchoring holds)', () => {
    expect(
      previewTokenFromHost('550e8400e29b41d4a716446655440000--abcd1234.localhost.evil.com')
    ).toBeNull();
    expect(previewTokenFromHost('localhost')).toBeNull();
  });
});
