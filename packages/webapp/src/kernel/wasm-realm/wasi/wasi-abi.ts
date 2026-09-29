/**
 * `wasi-abi.ts` — the numbers of WASI preview1 (`wasi_snapshot_preview1`)
 * the host speaks: errno, file types, rights, flags, and the byte layouts of
 * the structs it writes into the program's memory.
 */

/** WASI errno values (preview1 `errno`). */
export const E = {
  SUCCESS: 0,
  '2BIG': 1,
  ACCES: 2,
  ADDRINUSE: 3,
  ADDRNOTAVAIL: 4,
  AFNOSUPPORT: 5,
  AGAIN: 6,
  ALREADY: 7,
  BADF: 8,
  BUSY: 10,
  CHILD: 12,
  CONNREFUSED: 14,
  CONNRESET: 15,
  EXIST: 20,
  FAULT: 21,
  FBIG: 22,
  INPROGRESS: 26,
  INTR: 27,
  INVAL: 28,
  IO: 29,
  ISCONN: 30,
  ISDIR: 31,
  LOOP: 32,
  MFILE: 33,
  NAMETOOLONG: 37,
  NETUNREACH: 40,
  NOENT: 44,
  NOEXEC: 45,
  NOMEM: 48,
  NOSPC: 51,
  NOSYS: 52,
  NOTCONN: 53,
  NOTDIR: 54,
  NOTEMPTY: 55,
  NOTSOCK: 57,
  NOTSUP: 58,
  NOTTY: 59,
  NXIO: 60,
  PERM: 63,
  PIPE: 64,
  PROTONOSUPPORT: 66,
  RANGE: 68,
  ROFS: 69,
  SPIPE: 70,
  SRCH: 71,
  TIMEDOUT: 73,
  XDEV: 75,
  NOTCAPABLE: 76,
} as const;

/** A POSIX errno name (kernel `KernelError`, sync-fs bridge `.code`) as a WASI errno. */
export function wasiErrnoOf(code: string | undefined): number {
  if (!code) return E.IO;
  const name = code.startsWith('E') ? code.slice(1) : code;
  if (name === 'OPNOTSUPP') return E.NOTSUP;
  if (name === 'WOULDBLOCK') return E.AGAIN;
  return (E as Record<string, number>)[name] ?? E.IO;
}

export const FILETYPE = {
  UNKNOWN: 0,
  BLOCK_DEVICE: 1,
  CHARACTER_DEVICE: 2,
  DIRECTORY: 3,
  REGULAR_FILE: 4,
  SOCKET_DGRAM: 5,
  SOCKET_STREAM: 6,
  SYMBOLIC_LINK: 7,
} as const;

export const RIGHTS = {
  FD_DATASYNC: 1n << 0n,
  FD_READ: 1n << 1n,
  FD_SEEK: 1n << 2n,
  FD_FDSTAT_SET_FLAGS: 1n << 3n,
  FD_SYNC: 1n << 4n,
  FD_TELL: 1n << 5n,
  FD_WRITE: 1n << 6n,
  /** Every right preview1 defines (bits 0-29). */
  ALL: (1n << 30n) - 1n,
} as const;

export const OFLAGS = { CREAT: 1, DIRECTORY: 2, EXCL: 4, TRUNC: 8 } as const;
export const FDFLAGS = { APPEND: 1, DSYNC: 2, NONBLOCK: 4, RSYNC: 8, SYNC: 16 } as const;
export const LOOKUP_SYMLINK_FOLLOW = 1;
export const WHENCE = { SET: 0, CUR: 1, END: 2 } as const;
export const CLOCK = { REALTIME: 0, MONOTONIC: 1, PROCESS_CPUTIME: 2, THREAD_CPUTIME: 3 } as const;
export const FSTFLAGS = { ATIM: 1, ATIM_NOW: 2, MTIM: 4, MTIM_NOW: 8 } as const;
export const EVENTTYPE = { CLOCK: 0, FD_READ: 1, FD_WRITE: 2 } as const;
export const SUBCLOCK_ABSTIME = 1;
export const PREOPENTYPE_DIR = 0;

/** Struct sizes (bytes) in the program's memory. */
export const SIZE = {
  FILESTAT: 64,
  FDSTAT: 24,
  DIRENT: 24,
  SUBSCRIPTION: 48,
  EVENT: 32,
} as const;

/** WASI's signal numbers (proc_raise) — Linux's for 1-15, then its own order. */
export const WASI_SIGNAL_TO_POSIX: Readonly<Record<number, number>> = {
  1: 1,
  2: 2,
  3: 3,
  4: 4,
  5: 5,
  6: 6,
  7: 7,
  8: 8,
  9: 9,
  10: 10,
  11: 11,
  12: 12,
  13: 13,
  14: 14,
  15: 15,
  16: 17, // CHLD
  17: 18, // CONT
  18: 19, // STOP
  19: 20, // TSTP
};
