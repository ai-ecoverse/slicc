import { describe, it, expect } from 'vitest';
import { canonicalRuntimeId } from '../../src/ui/runtime-identity.js';

describe('canonicalRuntimeId', () => {
  it('prefixes a bootstrap id', () => {
    expect(canonicalRuntimeId('abc')).toBe('follower-abc');
  });
  it('is idempotent for already-canonical ids', () => {
    expect(canonicalRuntimeId('follower-abc')).toBe('follower-abc');
  });
  it('throws on empty input', () => {
    expect(() => canonicalRuntimeId('')).toThrow();
  });
});
