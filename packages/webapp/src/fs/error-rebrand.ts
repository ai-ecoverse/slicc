import { FsError, type FsErrorCode } from './types.js';

export function rebrandFsError(err: unknown, normalizedPath: string): never {
  if (err instanceof FsError) {
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
  'ENOSYS',
  'EIO',
];

export function convertError(err: unknown, path: string): FsError {
  if (err instanceof FsError) return err;

  {
    const overflowMsg = err instanceof Error ? err.message : String(err);
    if (overflowMsg.includes('maximum size exceeded')) {
      return new FsError(
        'EIO',
        `internal overflow, not storage: ${overflowMsg} — reload the session`,
        path
      );
    }

    if (overflowMsg.includes('call stack size exceeded')) {
      return new FsError(
        'EIO',
        `internal overflow, not storage: ${overflowMsg} — reload the session`,
        path
      );
    }
  }

  const structured = (err as { code?: unknown })?.code;
  if (typeof structured === 'string') {
    const code = structured as FsErrorCode;
    if ((KNOWN_CODES as string[]).includes(code)) {
      let msg = err instanceof Error ? err.message : String(err);

      if (msg.startsWith(`${code}: `)) {
        msg = msg.slice(code.length + 2);
        msg = msg.replace(/, undefined( '[^']*')?$/, '').replace(/ '[^']*'$/, '');
      }
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

  return new FsError('EINVAL', msg, path);
}
