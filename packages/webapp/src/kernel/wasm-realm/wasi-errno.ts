const WASI_ERRNO: Readonly<Partial<Record<string, number>>> = {
  EACCES: 2,
  EADDRINUSE: 3,
  EADDRNOTAVAIL: 4,
  EAFNOSUPPORT: 5,
  EAGAIN: 6,
  ECONNREFUSED: 14,
  EINPROGRESS: 26,
  EISCONN: 30,
  ENETUNREACH: 40,
  ENOTCONN: 53,
  ENOTSOCK: 57,
  EPROTONOSUPPORT: 66,

  EOPNOTSUPP: 138,
  EBADF: 8,
  ECHILD: 12,
  EINTR: 27,
  EINVAL: 28,
  EIO: 29,
  EMFILE: 33,
  ENOENT: 44,
  ENOSYS: 52,
  ENOTTY: 59,
  EPERM: 63,
  EPIPE: 64,
  ESPIPE: 70,
  ESRCH: 71,
};

const EIO = 29;

export function wasiErrno(code: string): number {
  return WASI_ERRNO[code] ?? EIO;
}
