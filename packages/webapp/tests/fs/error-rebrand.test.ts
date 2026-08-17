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

describe('convertError on pre-formatted ZenFS messages (#2146)', () => {
  it('strips the code prefix, dangling undefined syscall, and quoted path', () => {
    const zenfsErr = Object.assign(
      new Error("ENOTDIR: not a directory, undefined '/__opfs__/slicc-fs/tmp/foo'"),
      { code: 'ENOTDIR' }
    );
    const out = convertError(zenfsErr, '/tmp/foo');
    // Pre-fix this produced the degraded double-wrapped shape:
    // "ENOTDIR: ENOTDIR: not a directory, undefined '/__opfs__/…' '/tmp/foo'"
    expect(out.message).toBe("ENOTDIR: not a directory '/tmp/foo'");
    expect(out.code).toBe('ENOTDIR');
    expect(out.path).toBe('/tmp/foo');
  });

  it('keeps a plain structured message intact', () => {
    const err = Object.assign(new Error('some backend detail'), { code: 'EIO' });
    const out = convertError(err, '/x');
    expect(out.message).toBe("EIO: some backend detail '/x'");
  });

  it('preserves quoted details in unformatted backend errors (#2148 P2)', () => {
    // Only the pre-formatted ZenFS shape gets its trailing quote stripped —
    // a quoted value in an ordinary diagnostic is not a path decoration.
    const err = Object.assign(new Error("cannot open key 'config.json'"), { code: 'EIO' });
    const out = convertError(err, '/settings');
    expect(out.message).toBe("EIO: cannot open key 'config.json' '/settings'");
  });
});
