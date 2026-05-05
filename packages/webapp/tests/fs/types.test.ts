import { describe, it, expect } from 'vitest';
import { FsError } from '../../src/fs/types.js';

describe('FsError extended codes', () => {
  it.each([
    ['EBUSY', '412 conflict — concurrent write'],
    ['EFBIG', 'body too large'],
    ['EBADF', 'mount closed'],
    ['EIO', 'network failure'],
  ] as const)('constructs FsError with code %s', (code, msg) => {
    const err = new FsError(code, msg, '/mnt/r2/foo');
    expect(err.code).toBe(code);
    expect(err.path).toBe('/mnt/r2/foo');
    expect(err.message).toContain(code);
    expect(err.message).toContain(msg);
    expect(err).toBeInstanceOf(Error);
  });
});
