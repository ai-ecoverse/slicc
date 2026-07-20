import { FsError, type FsErrorCode } from './types.js';

/**
 * Re-throw an `FsError` from a backend with the VFS-absolute path. Backend
 * implementations are agnostic to where they're mounted, so they throw with
 * mount-relative paths (e.g. `'pack'`); callers expect the path they passed
 * in (e.g. `'/mnt/repo/pack'`).
 */
export function rebrandFsError(err: unknown, normalizedPath: string): never {
  if (err instanceof FsError) {
    // FsError's `message` field is the constructor parameter; the displayed
    // Error.message is `${code}: ${message}${path ? ` '${path}'` : ''}`.
    // Extract the inner message so the rebranded error keeps the same text.
    const codePrefix = `${err.code}: `;
    let inner = err.message;
    if (inner.startsWith(codePrefix)) inner = inner.slice(codePrefix.length);
    if (err.path && inner.endsWith(` '${err.path}'`)) {
      inner = inner.slice(0, inner.length - ` '${err.path}'`.length);
    }
    throw new FsError(err.code, inner, normalizedPath);
  }
  throw err;
}

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
