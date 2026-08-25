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
  'ENOSYS',
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
  // V8 caps Set/Map at 2^24 elements; an overflowing structure inside the FS
  // stack (kerium's log backlog, 2026-08-18 incident) throws
  // `RangeError: Set maximum size exceeded` into every operation. ZenFS wraps
  // it as EINVAL, which made a data-structure overflow read as a storage
  // problem ("file system too full"). Detect the marker before the code
  // mapping — whether it arrives raw or already errno-wrapped — and surface
  // it as EIO with an explicit label instead.
  {
    const overflowMsg = err instanceof Error ? err.message : String(err);
    if (overflowMsg.includes('maximum size exceeded')) {
      return new FsError(
        'EIO',
        `internal overflow, not storage: ${overflowMsg} — reload the session`,
        path
      );
    }
    // Same class, different marker: a STACK overflow. `RangeError: Maximum
    // call stack size exceeded` shares no substring with the Set/Map guard
    // above ('call stack size exceeded' vs 'maximum size exceeded'), carries
    // no `.code`, and matches no errno text — so it fell all the way through
    // to the EINVAL default and users saw
    // `EINVAL: Maximum call stack size exceeded` on writes. That reads as a
    // bad argument, and worse, `withKindMismatchRetryPaths` treats EINVAL as
    // a poisoned-index entry: every overflow bought a pointless OPFS probe
    // and a retry that overflowed again. The known source was ZenFS'
    // `Index._alloc` spreading the whole index into `Math.max`
    // (zen-fs/core#312, fixed in patches/@zenfs+core+2.6.2.patch); this guard
    // makes any future engine-limit failure name itself instead.
    if (overflowMsg.includes('call stack size exceeded')) {
      return new FsError(
        'EIO',
        `internal overflow, not storage: ${overflowMsg} — reload the session`,
        path
      );
    }
  }
  // ZenFS ErrnoError carries `.code` directly (POSIX string).
  const structured = (err as { code?: unknown })?.code;
  if (typeof structured === 'string') {
    const code = structured as FsErrorCode;
    if ((KNOWN_CODES as string[]).includes(code)) {
      let msg = err instanceof Error ? err.message : String(err);
      // ZenFS messages arrive pre-formatted (`ENOTDIR: not a directory,
      // undefined '/__opfs__/…'`). FsError re-prefixes the code and
      // re-appends its own quoted path, so wrapping the formatted string
      // verbatim produced `ENOTDIR: ENOTDIR: …, undefined '…' '…'` — the
      // degraded double-wrapped shape from #2146. Strip the code prefix,
      // the dangling `undefined` syscall slot, and any trailing quoted
      // path, mirroring rebrandFsError above.
      // Only a message that arrived PRE-FORMATTED (leading `CODE: `) is a
      // ZenFS errno string whose trailing `syscall 'path'` decoration should
      // be stripped. A plain structured message keeps its quoted details —
      // `EIO: cannot open key 'config.json'` is a diagnostic, not a path
      // (Codex P2 on #2148).
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
  // Default to EINVAL for unknown errors
  return new FsError('EINVAL', msg, path);
}
