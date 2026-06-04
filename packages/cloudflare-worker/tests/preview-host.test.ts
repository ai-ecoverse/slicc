import { describe, expect, it } from 'vitest';
import { previewTokenFromHost } from '../src/preview-host.js';

describe('previewTokenFromHost', () => {
  it('extracts the full token from a prod preview host (including embedded dot)', () => {
    expect(
      previewTokenFromHost('550e8400-e29b-41d4-a716-446655440000.deadbeef.preview.sliccy.ai')
    ).toBe('550e8400-e29b-41d4-a716-446655440000.deadbeef');
  });

  it('extracts the full token from a staging preview host', () => {
    expect(previewTokenFromHost('tray1.secret123.preview.staging.sliccy.ai')).toBe(
      'tray1.secret123'
    );
  });

  it('is case-insensitive on the suffix', () => {
    expect(previewTokenFromHost('tray.hex.preview.SLICCY.AI')).toBe('tray.hex');
  });

  it('returns null for non-preview hosts', () => {
    expect(previewTokenFromHost('www.sliccy.ai')).toBeNull();
    expect(previewTokenFromHost('example.com')).toBeNull();
    expect(previewTokenFromHost('preview.sliccy.ai')).toBeNull(); // no token prefix
  });

  it('returns null for malformed hosts', () => {
    expect(previewTokenFromHost('')).toBeNull();
    expect(previewTokenFromHost('.preview.sliccy.ai')).toBeNull();
  });
});
