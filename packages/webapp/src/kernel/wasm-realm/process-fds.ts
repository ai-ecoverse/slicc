/**
 * `process-fds.ts` — descriptor semantics a wasm-realm program gets from its
 * runtime (#3530) beyond Emscripten's single-process FS.
 *
 * - **FD_CLOEXEC.** Emscripten answers F_GETFD with 0, ignores F_SETFD and
 *   pipe2's O_CLOEXEC, and keeps open's and dup3's O_CLOEXEC in the flags of
 *   the open file description, which every dup shares. The runtime keeps
 *   FD_CLOEXEC per fd instead, on the stream (`sliccCloexec`): open takes
 *   O_CLOEXEC out of the description's flags, a dup starts without it, and
 *   the glue's own fcntl / pipe2 / dup3 / socket / accept4 (wrapped in its
 *   import object) read and set it. A child the program spawns or execs
 *   inherits every other fd (`process-fork.ts`, `describeInherited`).
 * - **`/dev/fd/N`** (and `/proc/self/fd/N`, `/dev/stdin`, `/dev/stdout`,
 *   `/dev/stderr`): opening one dups the process's own fd N, as on the BSDs,
 *   and stat() of one is fstat(N). `/dev/fd` is a link to Emscripten's
 *   `/proc/self/fd`, which gets the attributes Emscripten leaves out (a
 *   directory of symlinks), so it lists and readlinks as on Linux. This is what
 *   bash's process substitution hands a command: `diff <(a) <(b)` runs
 *   `diff /dev/fd/63 /dev/fd/62`.
 */
import type { ProcessFs, ProcessStream } from './kernel-streams.js';
import { type PtyKernel, ptyIoctl } from './process-pty.js';
import { wasiErrno } from './wasi-errno.js';

/** musl's O_CLOEXEC (and SOCK_CLOEXEC, the same bit). */
export const O_CLOEXEC = 0o2000000;

const FD_CLOEXEC = 1;
const F_DUPFD = 0;
const F_GETFD = 1;
const F_SETFD = 2;
const F_GETFL = 3;
const F_DUPFD_CLOEXEC = 1030;

type CloexecStream = Pick<ProcessStream, 'sliccCloexec'>;

/** Whether `stream`'s fd is close-on-exec. */
export function closesOnExec(stream: CloexecStream): boolean {
  return stream.sliccCloexec === true;
}

export function setCloseOnExec(stream: CloexecStream, on: boolean): void {
  if (on) stream.sliccCloexec = true;
  else delete stream.sliccCloexec;
}

const tracked = new WeakSet<ProcessFs>();

/**
 * FD_CLOEXEC per fd: an open with O_CLOEXEC sets it (and leaves the
 * description's flags without it); a new fd from dup / dup2 / F_DUPFD starts
 * without it (dup3 and F_DUPFD_CLOEXEC set it after).
 */
export function trackCloseOnExec(Fs: ProcessFs): void {
  // Once per FS: the runtime installs it before static constructors, and again
  // (a no-op then) once up, for a glue whose preRun did not run.
  if (tracked.has(Fs)) return;
  tracked.add(Fs);
  if (typeof Fs.dupStream === 'function') {
    const dupStream = Fs.dupStream.bind(Fs);
    Fs.dupStream = (stream, fd) => {
      const copy = dupStream(stream, fd);
      setCloseOnExec(copy, false);
      return copy;
    };
  }
  if (typeof Fs.open === 'function') {
    const open = Fs.open.bind(Fs);
    Fs.open = (path, flags, mode) => {
      const cloexec = typeof flags === 'number' && (flags & O_CLOEXEC) !== 0;
      const stream = open(path, cloexec ? flags & ~O_CLOEXEC : flags, mode);
      setCloseOnExec(stream, cloexec);
      return stream;
    };
  }
}

/** A syscall of the glue: numbers (fds, flags, pointers) in, a result or -errno out. */
export type GlueSyscall = (...args: number[]) => number;

/** The glue's own syscall implementations the runtime wraps (absent: not in this program). */
export interface GlueSyscalls {
  fcntl?: GlueSyscall;
  pipe2?: GlueSyscall;
  dup3?: GlueSyscall;
  socket?: GlueSyscall;
  accept4?: GlueSyscall;
  /** ioctl(2): its pseudo-terminal requests go to the kernel (`process-pty.ts`). */
  ioctl?: GlueSyscall;
}

export interface CloexecDeps {
  /** The program's FS once the glue is up. */
  fs(): ProcessFs | undefined;
  /** Its linear memory as 32-bit words (fcntl's argument, pipe2's result). */
  heap(): Int32Array | undefined;
  /** The kernel's pseudo-terminals, for ioctl (absent: the glue's ioctl stays). */
  pty?: PtyKernel;
}

/** Mark or clear FD_CLOEXEC on the program's fd `fd` (no such fd: nothing). */
function marker(deps: CloexecDeps): (fd: number, on: boolean) => void {
  return (fd, on) => {
    const stream = deps.fs()?.getStream(fd);
    if (stream) setCloseOnExec(stream, on);
  };
}

/** fcntl(2) with F_GETFD / F_SETFD / F_DUPFD_CLOEXEC, and F_GETFL without O_CLOEXEC. */
function cloexecFcntl(fcntl: GlueSyscall, deps: CloexecDeps): GlueSyscall {
  const mark = marker(deps);
  return (fd, cmd, varargs) => {
    if (cmd === F_DUPFD_CLOEXEC) {
      const copy = fcntl(fd, F_DUPFD, varargs);
      if (copy >= 0) mark(copy, true);
      return copy;
    }
    if (cmd === F_GETFL) {
      // Linux reports no O_CLOEXEC among the status flags.
      const flags = fcntl(fd, cmd, varargs);
      return flags < 0 ? flags : flags & ~O_CLOEXEC;
    }
    if (cmd !== F_GETFD && cmd !== F_SETFD) return fcntl(fd, cmd, varargs);
    const stream = deps.fs()?.getStream(fd);
    if (!stream) return -wasiErrno('EBADF');
    if (cmd === F_GETFD) return closesOnExec(stream) ? FD_CLOEXEC : 0;
    const arg = deps.heap()?.[varargs >> 2];
    if (arg === undefined) return -wasiErrno('EINVAL');
    setCloseOnExec(stream, (arg & FD_CLOEXEC) !== 0);
    return 0;
  };
}

/** pipe2(2) with O_CLOEXEC on both ends. */
function cloexecPipe2(pipe2: GlueSyscall, deps: CloexecDeps): GlueSyscall {
  const mark = marker(deps);
  return (fdPtr, flags) => {
    const r = pipe2(fdPtr, flags & ~O_CLOEXEC);
    const heap = deps.heap();
    if (r === 0 && flags & O_CLOEXEC && heap) {
      mark(heap[fdPtr >> 2] as number, true);
      mark(heap[(fdPtr >> 2) + 1] as number, true);
    }
    return r;
  };
}

/**
 * A syscall returning a new fd, close-on-exec when argument `flagArg` has
 * O_CLOEXEC / SOCK_CLOEXEC (taken out: the glue would put it on the description).
 */
function cloexecByFlag(syscall: GlueSyscall, flagArg: number, deps: CloexecDeps): GlueSyscall {
  const mark = marker(deps);
  return (...args) => {
    const cloexec = ((args[flagArg] ?? 0) & O_CLOEXEC) !== 0;
    if (cloexec) args[flagArg] = (args[flagArg] as number) & ~O_CLOEXEC;
    const fd = syscall(...args);
    if (fd >= 0) mark(fd, cloexec);
    return fd;
  };
}

function wrappers(glue: GlueSyscalls, deps: CloexecDeps): Map<GlueSyscall, GlueSyscall> {
  const out = new Map<GlueSyscall, GlueSyscall>();
  if (glue.fcntl) out.set(glue.fcntl, cloexecFcntl(glue.fcntl, deps));
  if (glue.pipe2) out.set(glue.pipe2, cloexecPipe2(glue.pipe2, deps));
  // dup3(old, new, flags); socket(domain, type, protocol); accept4(fd, addr, len, flags).
  if (glue.dup3) out.set(glue.dup3, cloexecByFlag(glue.dup3, 2, deps));
  if (glue.socket) out.set(glue.socket, cloexecByFlag(glue.socket, 1, deps));
  if (glue.accept4) out.set(glue.accept4, cloexecByFlag(glue.accept4, 3, deps));
  if (glue.ioctl && deps.pty) {
    out.set(glue.ioctl, ptyIoctl(glue.ioctl, { fs: deps.fs, heap: deps.heap, kernel: deps.pty }));
  }
  return out;
}

/**
 * Replace the glue's fcntl / pipe2 / dup3 / socket / accept4 in `imports` (the
 * object the module is instantiated with) by FD_CLOEXEC-aware versions. The
 * import names may be minified, so they are found by identity.
 */
export function wrapCloexecSyscalls(
  imports: WebAssembly.Imports,
  glue: GlueSyscalls | undefined,
  deps: CloexecDeps
): void {
  if (!glue) return;
  const replace = wrappers(glue, deps);
  if (replace.size === 0) return;
  const seen = new Set<object>();
  for (const namespace of Object.values(imports)) {
    if (!namespace || typeof namespace !== 'object' || seen.has(namespace)) continue;
    seen.add(namespace);
    for (const [name, value] of Object.entries(namespace)) {
      const wrapped = replace.get(value as GlueSyscall);
      if (wrapped) namespace[name] = wrapped;
    }
  }
}

/** The instance's linear memory: exported, or imported (`-sIMPORTED_MEMORY`). */
export function wasmMemory(
  instance: WebAssembly.Instance,
  imports: WebAssembly.Imports
): WebAssembly.Memory | undefined {
  const isMemory = (v: unknown): v is WebAssembly.Memory => v instanceof WebAssembly.Memory;
  const exported = Object.values(instance.exports).find(isMemory);
  if (exported) return exported;
  for (const namespace of Object.values(imports)) {
    const found = Object.values(namespace ?? {}).find(isMemory);
    if (found) return found;
  }
  return undefined;
}

/** The fd a descriptor path names, or undefined when `path` is no such path. */
export function fdOfPath(path: string, cwd: string): number | undefined {
  const parts: string[] = [];
  for (const part of `${path.startsWith('/') ? '' : cwd}/${path}`.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  const abs = `/${parts.join('/')}`;
  const std = ['/dev/stdin', '/dev/stdout', '/dev/stderr'].indexOf(abs);
  if (std >= 0) return std;
  const m = /^\/(?:dev|proc\/self)\/fd\/(\d+)$/.exec(abs);
  return m ? Number(m[1]) : undefined;
}

const DIR_MODE = 0o040555;
const LINK_MODE = 0o120700;

/** stat(2) attributes of a synthetic node. */
function syntheticAttr(mode: number, ino: number): object {
  const now = new Date();
  return {
    dev: 1,
    ino,
    mode,
    nlink: 1,
    uid: 0,
    gid: 0,
    rdev: 0,
    size: 0,
    atime: now,
    mtime: now,
    ctime: now,
    blksize: 4096,
    blocks: 0,
  };
}

interface FdDirNode {
  id?: number;
  node_ops?: {
    lookup?: (parent: FdDirNode, name: string) => FdDirNode;
    getattr?: (node: FdDirNode) => object;
  };
}

/**
 * Emscripten's `/proc/self/fd` has no attributes, so stat and ls of it (or of
 * an entry, with lstat) fail with EPERM: make it a directory of symlinks.
 */
function describeFdDir(Fs: ProcessFs): void {
  let dir: FdDirNode | undefined;
  try {
    dir = Fs.lookupPath?.('/proc/self/fd', { follow: true })?.node as FdDirNode | undefined;
  } catch {
    return;
  }
  const ops = dir?.node_ops;
  const lookup = ops?.lookup;
  if (!dir || !lookup || ops.getattr) return;
  dir.node_ops = {
    ...ops,
    getattr: () => syntheticAttr(DIR_MODE, 1),
    lookup: (parent, name) => {
      const entry = lookup(parent, name);
      entry.node_ops = {
        ...entry.node_ops,
        getattr: () => syntheticAttr(LINK_MODE, entry.id ?? 0),
      };
      return entry;
    },
  };
}

/** Make `/dev/fd/N` and its aliases the process's own fd N (see the module comment). */
export function useDevFd(Fs: ProcessFs): void {
  if (typeof Fs.open !== 'function') return;
  try {
    Fs.symlink?.('/proc/self/fd', '/dev/fd');
  } catch {
    /* already there, or no /dev: open and stat below still answer */
  }
  describeFdDir(Fs);
  const fdOf = (path: unknown): number | undefined =>
    typeof path === 'string' ? fdOfPath(path, Fs.cwd()) : undefined;
  const target = (fd: number): ProcessStream => {
    const stream = Fs.getStream(fd);
    if (!stream) throw new Fs.ErrnoError(wasiErrno('EBADF'));
    return stream;
  };
  const open = Fs.open.bind(Fs);
  Fs.open = (path, flags, mode) => {
    const fd = fdOf(path);
    if (fd === undefined) return open(path, flags, mode);
    const copy = Fs.dupStream(target(fd), -1);
    setCloseOnExec(copy, typeof flags === 'number' && (flags & O_CLOEXEC) !== 0);
    return copy;
  };
  const { stat, fstat } = Fs;
  if (typeof stat !== 'function' || typeof fstat !== 'function') return;
  Fs.stat = (path, dontFollow) => {
    const fd = dontFollow ? undefined : fdOf(path);
    if (fd === undefined) return stat.call(Fs, path, dontFollow);
    target(fd);
    return fstat.call(Fs, fd);
  };
}
