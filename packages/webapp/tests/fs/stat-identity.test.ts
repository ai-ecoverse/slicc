import { describe, expect, it } from 'vitest';
import { inodeIdentity } from '../../src/fs/stat-identity.js';

describe('inode identity', () => {
  it('keeps independent namespaces and devices distinct without delimiter collisions', () => {
    expect(inodeIdentity('a', 2, 1)).not.toBe(inodeIdentity('b', 2, 1));
    expect(inodeIdentity('a', 2, 1)).not.toBe(inodeIdentity('a', 2, 2));
    expect(inodeIdentity('a:1', 2, 3)).not.toBe(inodeIdentity('a', 2, 13));
    expect(inodeIdentity('a', 2)).toBe(inodeIdentity('a', 2));
  });

  it.each([undefined, 0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'withholds unsafe inode %s',
    (ino) => {
      expect(inodeIdentity('fs', ino)).toBeUndefined();
    }
  );

  it.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'withholds unsafe device %s',
    (dev) => {
      expect(inodeIdentity('fs', 1, dev)).toBeUndefined();
    }
  );
});
