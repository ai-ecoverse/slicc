import { describe, expect, it } from 'vitest';
import { convertError, rebrandFsError } from '../../src/fs/error-rebrand.js';
import { FsError } from '../../src/fs/types.js';

describe('convertError', () => {
  it('passes through an existing FsError unchanged', () => {
    const e = new FsError('ENOENT', 'x', '/a');
    expect(convertError(e, '/b')).toBe(e);
  });

  it('maps a structured ZenFS .code to FsError', () => {
    const err = Object.assign(new Error('boom'), { code: 'EISDIR' });
    const out = convertError(err, '/dir');
    expect(out).toBeInstanceOf(FsError);
    expect(out.code).toBe('EISDIR');
    expect(out.path).toBe('/dir');
  });

  it.each([
    ['ENOENT: no such file or directory', 'ENOENT'],
    ['EEXIST: file exists', 'EEXIST'],
    ['ENOTDIR: not a directory', 'ENOTDIR'],
    ['EISDIR: illegal operation on a directory', 'EISDIR'],
    ['ENOTEMPTY: directory not empty', 'ENOTEMPTY'],
    ['ELOOP: too many symbolic links', 'ELOOP'],
  ])('falls back to substring matching for LightningFS-style %s', (message, expected) => {
    expect(convertError(new Error(message), '/p').code).toBe(expected);
  });

  it('treats a structured code outside the known set as an unknown error', () => {
    const err = Object.assign(new Error('cross-device'), { code: 'EXDEV' });
    expect(convertError(err, '/p').code).toBe('EINVAL');
  });

  it('defaults unknown errors to EINVAL', () => {
    const out = convertError(new Error('weird'), '/p');
    expect(out.code).toBe('EINVAL');
    expect(out.message).toContain('weird');
  });
});

describe('rebrandFsError', () => {
  it('rethrows an FsError with the caller-facing path', () => {
    const backendErr = new FsError('ENOENT', 'no such file or directory', 'pack');
    expect(() => rebrandFsError(backendErr, '/mnt/repo/pack')).toThrow(FsError);
    try {
      rebrandFsError(backendErr, '/mnt/repo/pack');
    } catch (e) {
      expect((e as FsError).code).toBe('ENOENT');
      expect((e as FsError).path).toBe('/mnt/repo/pack');
      // The rebranded message must keep the original inner text with the
      // caller-facing path — no duplicated suffix, no leftover code prefix.
      expect((e as FsError).message).toBe("ENOENT: no such file or directory '/mnt/repo/pack'");
    }
  });

  it('rethrows a non-FsError untouched', () => {
    const raw = new Error('native');
    expect(() => rebrandFsError(raw, '/x')).toThrow(raw);
  });
});
