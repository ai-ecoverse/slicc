import { describe, expect, it } from 'vitest';
import { parseByteRange } from '../src/byte-range.js';

describe('parseByteRange', () => {
  it('returns null with no header — the caller then serves the whole entity', () => {
    expect(parseByteRange(null, 100)).toBeNull();
    expect(parseByteRange(undefined, 100)).toBeNull();
    expect(parseByteRange('', 100)).toBeNull();
  });

  it('parses a closed range', () => {
    expect(parseByteRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
  });

  it('parses an open-ended range to the last byte', () => {
    expect(parseByteRange('bytes=500-', 1000)).toEqual({ start: 500, end: 999 });
  });

  it('parses a suffix range', () => {
    expect(parseByteRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 });
  });

  it('clamps a suffix larger than the entity to the whole entity', () => {
    expect(parseByteRange('bytes=-5000', 1000)).toEqual({ start: 0, end: 999 });
  });

  it('clamps an end past the last byte', () => {
    expect(parseByteRange('bytes=900-5000', 1000)).toEqual({ start: 900, end: 999 });
  });

  it('reports a start past the entity as unsatisfiable', () => {
    expect(parseByteRange('bytes=1000-', 1000)).toBe('unsatisfiable');
  });

  it('reports a zero-length suffix as unsatisfiable', () => {
    expect(parseByteRange('bytes=-0', 1000)).toBe('unsatisfiable');
  });

  // Anything we do not serve falls back to 200 + whole entity, which is
  // always a valid answer to a Range request.
  it.each(['items=0-10', 'bytes=0-10,20-30', 'bytes=abc', 'bytes=-', 'garbage'])(
    'falls back to null for %s',
    (header) => {
      expect(parseByteRange(header, 1000)).toBeNull();
    }
  );

  it('tolerates surrounding whitespace', () => {
    expect(parseByteRange('  bytes=0-9  ', 100)).toEqual({ start: 0, end: 9 });
  });
});
