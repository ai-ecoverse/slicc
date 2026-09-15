import { describe, expect, it } from 'vitest';
import { sameFileIdentity } from '../../src/fs/same-file-identity.js';

describe('sameFileIdentity', () => {
  it('rejects colliding device/inode pairs from different backend namespaces', () => {
    const local = { identity: 'zenfs:db:7:12', ino: 12, dev: 7 };
    const host = { identity: 'hostfs:bridge:7:12', ino: 12, dev: 7 };
    expect(sameFileIdentity(local, host)).toBe(false);
    expect(sameFileIdentity(local, { ino: 12, dev: 7 })).toBe(false);
    expect(sameFileIdentity({ ino: 12, dev: 7 }, local)).toBe(false);
    expect(sameFileIdentity(local, { ...local })).toBe(true);
  });

  it('accepts a shared scoped identity without requiring a native inode', () => {
    expect(sameFileIdentity({ identity: 'backend:file' }, { identity: 'backend:file' })).toBe(true);
  });

  it('matches positive inodes and rejects 0 / missing / mismatch', () => {
    expect(sameFileIdentity({ ino: 12 }, { ino: 12 })).toBe(true);
    expect(sameFileIdentity({ ino: 12 }, { ino: 13 })).toBe(false);
    expect(sameFileIdentity({ ino: 0 }, { ino: 0 })).toBe(false);
    expect(sameFileIdentity({}, { ino: 12 })).toBe(false);
    expect(sameFileIdentity({ ino: 12 }, {})).toBe(false);
  });

  it('same ino on different devices is not the same file', () => {
    expect(sameFileIdentity({ ino: 12, dev: 1 }, { ino: 12, dev: 2 })).toBe(false);
    expect(sameFileIdentity({ ino: 12, dev: 1 }, { ino: 12, dev: 1 })).toBe(true);
    expect(sameFileIdentity({ ino: 12, dev: 1 }, { ino: 12 })).toBe(false);
    expect(sameFileIdentity({ ino: 12 }, { ino: 12, dev: 1 })).toBe(false);
  });
});
