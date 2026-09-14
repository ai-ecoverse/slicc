import { describe, expect, it } from 'vitest';
import { SHARED_TMP_ROOT, scratchDir, TMPDIR_ENV } from '../../src/shell/tmpdir-env.js';

describe('scratchDir', () => {
  it('returns the unit scratch root the shell published', () => {
    expect(scratchDir(new Map([[TMPDIR_ENV, '/tmp/cone-adobe']]))).toBe('/tmp/cone-adobe');
    expect(scratchDir(new Map([[TMPDIR_ENV, '/tmp/cone-adobe/review']]))).toBe(
      '/tmp/cone-adobe/review'
    );
  });

  it('reads a plain-record env — hosts hand commands either shape', () => {
    expect(scratchDir({ [TMPDIR_ENV]: '/tmp/cone' })).toBe('/tmp/cone');
  });

  it('falls back to the shared root rather than failing', () => {
    expect(scratchDir(new Map())).toBe(SHARED_TMP_ROOT);
    expect(scratchDir({})).toBe(SHARED_TMP_ROOT);
    expect(scratchDir(undefined)).toBe(SHARED_TMP_ROOT);
  });

  it('returns a non-blank value verbatim, spaces and all', () => {
    expect(scratchDir(new Map([[TMPDIR_ENV, ' /tmp/odd name ']]))).toBe(' /tmp/odd name ');
    expect(scratchDir({ [TMPDIR_ENV]: '/tmp/trailing/' })).toBe('/tmp/trailing/');
  });

  it('treats an empty or whitespace value as unset, never as a relative path', () => {
    for (const bad of ['', '   ', '\t']) {
      expect(scratchDir(new Map([[TMPDIR_ENV, bad]]))).toBe(SHARED_TMP_ROOT);
    }
  });
});
