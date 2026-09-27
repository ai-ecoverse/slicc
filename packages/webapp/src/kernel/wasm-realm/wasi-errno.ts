const WASI_ERRNO: Readonly<Partial<Record<string, number>>> = {
  EBADF: 8,
  ECHILD: 12,
  EINVAL: 28,
  EIO: 29,
  EMFILE: 33,
  ENOENT: 44,
  ENOSYS: 52,
  EPIPE: 64,
};

const EIO = 29;

export function wasiErrno(code: string): number {
  return WASI_ERRNO[code] ?? EIO;
}
