import { describe, expect, it } from 'vitest';
import { previewTokenFromHost } from '../src/preview-host.js';

describe('previewTokenFromHost', () => {
  it('extracts and rehyphenates the UUID from a prod preview host', () => {
    // Subdomain has compact UUID (no hyphens) + '--' + secret
    const result = previewTokenFromHost('550e8400e29b41d4a716446655440000--deadbeef.sliccy.now');
    expect(result).toEqual({
      token: '550e8400-e29b-41d4-a716-446655440000.deadbeef',
      userHash: null,
    });
  });

  it('extracts the full token from a staging preview host (sliccy.dev)', () => {
    const result = previewTokenFromHost(
      '1ed1735cdce743d89e883a547d5deb5a--f67ad751feb0ad34.sliccy.dev'
    );
    expect(result).toEqual({
      token: '1ed1735c-dce7-43d8-9e88-3a547d5deb5a.f67ad751feb0ad34',
      userHash: null,
    });
  });

  it('is case-insensitive on the suffix', () => {
    const result = previewTokenFromHost('550e8400e29b41d4a716446655440000--abcd1234.SLICCY.NOW');
    expect(result).toEqual({
      token: '550e8400-e29b-41d4-a716-446655440000.abcd1234',
      userHash: null,
    });
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
    expect(
      previewTokenFromHost('1ed1735cdce743d89e883a547d5deb5a--f67ad751.localhost:8787')
    ).toEqual({ token: '1ed1735c-dce7-43d8-9e88-3a547d5deb5a.f67ad751', userHash: null });
    expect(previewTokenFromHost('550e8400e29b41d4a716446655440000--abcd1234.localhost')).toEqual({
      token: '550e8400-e29b-41d4-a716-446655440000.abcd1234',
      userHash: null,
    });
  });

  it('does not match a non-terminal localhost label (anchoring holds)', () => {
    expect(
      previewTokenFromHost('550e8400e29b41d4a716446655440000--abcd1234.localhost.evil.com')
    ).toBeNull();
    expect(previewTokenFromHost('localhost')).toBeNull();
  });

  // New format: <compactUUID>--<userHash8>-<secret20>
  it('extracts token and userHash from new-format prod host', () => {
    const result = previewTokenFromHost(
      '550e8400e29b41d4a716446655440000--ab12cd34-ff00112233445566778899aa.sliccy.now'
    );
    expect(result).toEqual({
      token: '550e8400-e29b-41d4-a716-446655440000.ff00112233445566778899aa',
      userHash: 'ab12cd34',
    });
  });

  it('extracts token and userHash from new-format staging host', () => {
    const result = previewTokenFromHost(
      '1ed1735cdce743d89e883a547d5deb5a--deadbeef-aabbccddeeff00112233.sliccy.dev'
    );
    expect(result).toEqual({
      token: '1ed1735c-dce7-43d8-9e88-3a547d5deb5a.aabbccddeeff00112233',
      userHash: 'deadbeef',
    });
  });

  it('extracts token and userHash from new-format localhost host', () => {
    const result = previewTokenFromHost(
      '550e8400e29b41d4a716446655440000--00000000-ff00112233445566778899aa.localhost:8787'
    );
    expect(result).toEqual({
      token: '550e8400-e29b-41d4-a716-446655440000.ff00112233445566778899aa',
      userHash: '00000000',
    });
  });
});
