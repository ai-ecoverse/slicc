/** Emscripten's (WASI) errno numbers for the kernel errors a syscall returns. */
const WASI_ERRNO: Readonly<Partial<Record<string, number>>> = {
  EBADF: 8,
  ECHILD: 12,
  EINTR: 27,
  EINVAL: 28,
  EIO: 29,
  EMFILE: 33,
  ENOENT: 44,
  ENOSYS: 52,
  ENOTTY: 59,
  EPIPE: 64,
  ESPIPE: 70,
  ESRCH: 71,
};

const EIO = 29;

/** The WASI errno of a failed syscall (EIO for one the table does not know). */
export function wasiErrno(code: string): number {
  return WASI_ERRNO[code] ?? EIO;
}
