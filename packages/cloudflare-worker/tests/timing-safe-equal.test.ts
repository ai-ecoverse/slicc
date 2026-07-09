import { describe, expect, it } from 'vitest';
import { timingSafeEqual } from '../src/timing-safe-equal.js';

describe('timingSafeEqual', () => {
  it('returns true for matching tokens', () => {
    const token = 'abc-123-def-456';
    expect(timingSafeEqual(token, token)).toBe(true);
  });

  it('returns true for equal but distinct strings', () => {
    expect(timingSafeEqual('secret-token', 'secret-token')).toBe(true);
  });

  it('returns false for non-matching same-length strings', () => {
    expect(timingSafeEqual('aaaa', 'bbbb')).toBe(false);
  });

  it('returns false for different-length strings', () => {
    expect(timingSafeEqual('short', 'a-longer-string')).toBe(false);
  });

  it('returns false for empty received vs non-empty expected', () => {
    expect(timingSafeEqual('', 'expected-token')).toBe(false);
  });

  it('returns false for non-empty received vs empty expected', () => {
    expect(timingSafeEqual('some-token', '')).toBe(false);
  });

  it('returns true for two empty strings', () => {
    expect(timingSafeEqual('', '')).toBe(true);
  });

  it('handles UUID-style tokens', () => {
    const uuid = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
    expect(timingSafeEqual(uuid, uuid)).toBe(true);
    expect(timingSafeEqual(uuid, 'f47ac10b-58cc-4372-a567-0e02b2c3d478')).toBe(false);
  });

  it('handles multi-byte (UTF-8) characters', () => {
    expect(timingSafeEqual('héllo', 'héllo')).toBe(true);
    expect(timingSafeEqual('héllo', 'hèllo')).toBe(false);
  });
});
