import { FsError, type FsErrorCode } from './types.js';

const KNOWN_CODES: FsErrorCode[] = [
  'ENOENT',
  'EEXIST',
  'ENOTDIR',
  'EISDIR',
  'ENOTEMPTY',
  'EINVAL',
  'EACCES',
  'ELOOP',
  'EBUSY',
  'EFBIG',
  'EBADF',
  'EIO',
];

/**
 * Convert LightningFS / ZenFS errors to {@link FsError}.
 *
 * ZenFS throws `ErrnoError` with a `.code` POSIX string (and `.errno`);
 * LightningFS embeds the code in the message text. Prefer the structured
 * `.code` form so we carry through codes ZenFS reports verbatim, then fall
 * back to substring matching for LightningFS.
 */
export function convertError(err: unknown, path: string): FsError {
  if (err instanceof FsError) return err;
  // ZenFS ErrnoError carries `.code` directly (POSIX string).
  const structured = (err as { code?: unknown })?.code;
  if (typeof structured === 'string') {
    const code = structured as FsErrorCode;
    if ((KNOWN_CODES as string[]).includes(code)) {
      const msg = err instanceof Error ? err.message : String(err);
      return new FsError(code, msg || code, path);
    }
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('ENOENT')) {
    return new FsError('ENOENT', 'no such file or directory', path);
  }
  if (msg.includes('EEXIST')) {
    return new FsError('EEXIST', 'file already exists', path);
  }
  if (msg.includes('ENOTDIR')) {
    return new FsError('ENOTDIR', 'not a directory', path);
  }
  if (msg.includes('EISDIR')) {
    return new FsError('EISDIR', 'is a directory', path);
  }
  if (msg.includes('ENOTEMPTY')) {
    return new FsError('ENOTEMPTY', 'directory not empty', path);
  }
  if (msg.includes('ELOOP')) {
    return new FsError('ELOOP', 'too many levels of symbolic links', path);
  }
  // Default to EINVAL for unknown errors
  return new FsError('EINVAL', msg, path);
}
