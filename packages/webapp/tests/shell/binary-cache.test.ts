/**
 * Tests for the binary data cache used to preserve byte fidelity
 * through just-bash's string-typed FetchResult.body pipeline.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cacheBinaryBody, consumeCachedBinary } from './binary-cache.js';

describe('binary-cache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stores and retrieves binary data', () => {
    const body = 'hello';
    const bytes = new Uint8Array([104, 101, 108, 108, 111]);
    cacheBinaryBody(body, bytes);
    const result = consumeCachedBinary(body);
    expect(result).toEqual(bytes);
  });

  it('returns null for uncached strings', () => {
    expect(consumeCachedBinary('not-cached')).toBeNull();
  });

  it('consumes entry on first retrieval (single-use)', () => {
    const body = 'test';
    const bytes = new Uint8Array([1, 2, 3]);
    cacheBinaryBody(body, bytes);
    expect(consumeCachedBinary(body)).toEqual(bytes);
    expect(consumeCachedBinary(body)).toBeNull();
  });

  it('handles empty string body', () => {
    const bytes = new Uint8Array([]);
    cacheBinaryBody('', bytes);
    const result = consumeCachedBinary('');
    expect(result).toEqual(bytes);
  });

  it('handles binary data with all byte values', () => {
    // Latin1-encoded binary: every byte value 0-255
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    const latin1 = Array.from(bytes, (b) => String.fromCharCode(b)).join('');

    cacheBinaryBody(latin1, bytes);
    const result = consumeCachedBinary(latin1);
    expect(result).toEqual(bytes);
  });

  it('auto-expires entries after 10 seconds', () => {
    const body = 'expiring';
    const bytes = new Uint8Array([42]);
    cacheBinaryBody(body, bytes);

    // Before expiry
    vi.advanceTimersByTime(9999);
    expect(consumeCachedBinary(body)).toEqual(bytes);

    // Re-cache and let it expire
    cacheBinaryBody(body, bytes);
    vi.advanceTimersByTime(10001);
    expect(consumeCachedBinary(body)).toBeNull();
  });

  it('supports multiple concurrent entries with different keys', () => {
    // Use strings that differ in length and sampled positions to avoid key collision
    const body1 = 'short';
    const bytes1 = new Uint8Array([1, 2, 3]);
    const body2 = 'a much longer string that differs significantly';
    const bytes2 = new Uint8Array([4, 5, 6]);

    cacheBinaryBody(body1, bytes1);
    cacheBinaryBody(body2, bytes2);

    expect(consumeCachedBinary(body1)).toEqual(bytes1);
    expect(consumeCachedBinary(body2)).toEqual(bytes2);
  });
});
