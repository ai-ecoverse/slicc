import { describe, expect, it } from 'vitest';
import { formatBytes, formatBytesBinary, formatBytesSi } from '../../src/base/format-bytes.js';

describe('formatBytesBinary', () => {
  it('scales through B/KB/MB/GB with one decimal', () => {
    expect(formatBytesBinary(512)).toBe('512 B');
    expect(formatBytesBinary(2048)).toBe('2.0 KB');
    expect(formatBytesBinary(3 * 1024 * 1024)).toBe('3.0 MB');
    expect(formatBytesBinary(5.5 * 1024 * 1024 * 1024)).toBe('5.5 GB');
  });

  it('reaches TB and PB', () => {
    expect(formatBytesBinary(2 * 1024 ** 4)).toBe('2.0 TB');
    expect(formatBytesBinary(3 * 1024 ** 5)).toBe('3.0 PB');
  });

  it('is the default for formatBytes()', () => {
    expect(formatBytes(2048)).toBe(formatBytesBinary(2048));
    expect(formatBytes(2048, { si: false })).toBe('2.0 KB');
  });

  it('preserves nonzero fractional byte rates instead of rounding to 0 B', () => {
    expect(formatBytesBinary(0.4)).toBe('0.4 B');
    expect(formatBytesBinary(1 / 3)).toBe('0.3 B');
    expect(formatBytesBinary(0.04)).toBe('0.04 B');
    expect(formatBytesBinary(0.004)).toBe('0.01 B');
  });
});

describe('formatBytesSi', () => {
  it('uses base-1000 with kB spelling and coarse precision', () => {
    expect(formatBytesSi(512)).toBe('512 B');
    expect(formatBytesSi(1_234_567)).toBe('1.2 MB');
    expect(formatBytesSi(12_345_678)).toBe('12 MB');
    expect(formatBytes(1_234_567, { si: true })).toBe('1.2 MB');
  });

  it('diverges from binary for the same byte count', () => {
    const n = 1_000_000;
    expect(formatBytesSi(n)).toBe('1.0 MB');
    expect(formatBytesBinary(n)).toBe('976.6 KB');
  });
});

describe('formatBytes edge cases', () => {
  it('returns empty string for non-finite or negative inputs', () => {
    expect(formatBytes(Number.NaN)).toBe('');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('');
    expect(formatBytes(-1)).toBe('');
    expect(formatBytesSi(-10)).toBe('');
  });
});
