import { describe, expect, it } from 'vitest';
import { sameFileIdentity } from '../../src/fs/same-file-identity.js';

describe('sameFileIdentity', () => {
  it('matches positive inodes and rejects 0 / missing / mismatch', () => {
    expect(sameFileIdentity({ ino: 12 }, { ino: 12 })).toBe(true);
    expect(sameFileIdentity({ ino: 12 }, { ino: 13 })).toBe(false);
    expect(sameFileIdentity({ ino: 0 }, { ino: 0 })).toBe(false);
    expect(sameFileIdentity({}, { ino: 12 })).toBe(false);
    expect(sameFileIdentity({ ino: 12 }, {})).toBe(false);
  });
});
