/**
 * `process-pty.ts` — an Emscripten program's side of the kernel's
 * pseudo-terminals (`pty.ts`): the ioctls musl's `posix_openpt` /
 * `unlockpt` / `ptsname` / `openpty` / `login_tty` make on them, and the
 * packet mode GNU screen sets (TIOCPKT), which Emscripten's own `ioctl`
 * does not know, answered by the kernel. The
 * glue's `__syscall_ioctl` is wrapped like its fcntl (`process-fds.ts`);
 * any other request goes to it unchanged.
 */
import type { ProcessFs } from './kernel-streams.js';
import type { GlueSyscall } from './process-fds.js';
import { wasiErrno } from './wasi-errno.js';

/** Linux's (and musl's) request numbers. */
export const TIOCGPTN = 0x80045430;
export const TIOCSPTLCK = 0x40045431;
export const TIOCSCTTY = 0x540e;
export const TIOCSWINSZ = 0x5414;
export const TIOCPKT = 0x5420;

/** The kernel calls behind them, on kernel descriptors. */
export interface PtyKernel {
  /** TIOCGPTN: the master's pty number. */
  ptyNumber(kfd: number): number;
  /** TIOCSPTLCK: lock (or, with false, unlock) the master's slave. */
  ptyLock(kfd: number, lock: boolean): void;
  /** TIOCSCTTY: the terminal becomes the session's controlling terminal. */
  setControllingTerminal(kfd: number): void;
  /** TIOCPKT: packet mode on (or off) for a master's reads. */
  setPacketMode(kfd: number, on: boolean): void;
  /** TIOCSWINSZ, on a terminal or a master. */
  setWinsize(kfd: number, rows: number, cols: number): void;
}

export interface PtyIoctlDeps {
  fs(): ProcessFs | undefined;
  /** The program's memory as 32-bit words. */
  heap(): Int32Array | undefined;
  kernel: PtyKernel;
}

/** A kernel error's negated errno (what a glue syscall returns), else rethrow. */
function failed(e: unknown): number {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === 'string') return -wasiErrno(code);
  throw e;
}

/** ioctl(2) with the pseudo-terminal requests answered by the kernel. */
export function ptyIoctl(ioctl: GlueSyscall, deps: PtyIoctlDeps): GlueSyscall {
  return (fd, op, varargs) => {
    const request = op >>> 0;
    if (
      request !== TIOCGPTN &&
      request !== TIOCSPTLCK &&
      request !== TIOCSCTTY &&
      request !== TIOCSWINSZ &&
      request !== TIOCPKT
    ) {
      // termios and TIOCGWINSZ: the glue's terminal hooks, which the kernel answers.
      return ioctl(fd, op, varargs);
    }
    const stream = deps.fs()?.getStream(fd);
    const kfd = (stream as { sliccKernelFd?: number } | undefined)?.sliccKernelFd;
    // Not on a kernel descriptor: the glue answers.
    if (kfd === undefined) return ioctl(fd, op, varargs);
    const heap = deps.heap();
    if (!heap) return -wasiErrno('EFAULT');
    const argp = (heap[varargs >> 2] ?? 0) >>> 0;
    try {
      return answer(request, kfd, argp, heap, deps.kernel);
    } catch (e) {
      return failed(e);
    }
  };
}

function answer(
  request: number,
  kfd: number,
  argp: number,
  heap: Int32Array,
  kernel: PtyKernel
): number {
  switch (request) {
    case TIOCGPTN:
      heap[argp >> 2] = kernel.ptyNumber(kfd);
      return 0;
    case TIOCSPTLCK:
      kernel.ptyLock(kfd, (heap[argp >> 2] ?? 0) !== 0);
      return 0;
    case TIOCSCTTY:
      kernel.setControllingTerminal(kfd);
      return 0;
    case TIOCPKT:
      kernel.setPacketMode(kfd, (heap[argp >> 2] ?? 0) !== 0);
      return 0;
    default: {
      // TIOCSWINSZ: struct winsize { unsigned short ws_row, ws_col, ws_xpixel, ws_ypixel; }
      const word = heap[argp >> 2] ?? 0;
      kernel.setWinsize(kfd, word & 0xffff, (word >>> 16) & 0xffff);
      return 0;
    }
  }
}
