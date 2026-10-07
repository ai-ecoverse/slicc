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
import type { ProcessFs, ProcessStream, ProcessSys } from './kernel-streams.js';
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
  /** Emscripten's `_setitimer_js(which, ms)`: ITIMER_REAL goes to the kernel's clock. */
  setitimer?: GlueSyscall;
}

export interface CloexecDeps {
  /** The program's FS once the glue is up. */
  fs(): ProcessFs | undefined;
  /** Its linear memory as 32-bit words (fcntl's argument, pipe2's result). */
  heap(): Int32Array | undefined;
  /** The kernel's pseudo-terminals, for ioctl (absent: the glue's ioctl stays). */
  pty?: PtyKernel;
  /** The kernel's interval timer, for ITIMER_REAL (absent: the glue's setTimeout stays). */
  timer?: { arm(ms: number): void };
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

type SyscallName = keyof GlueSyscalls;

/** Each syscall's import name, as an unminified glue (an assertions build) has it. */
const IMPORT_NAMES: Readonly<Record<SyscallName, string>> = {
  fcntl: '__syscall_fcntl64',
  pipe2: '__syscall_pipe2',
  dup3: '__syscall_dup3',
  socket: '__syscall_socket',
  accept4: '__syscall_accept4',
  ioctl: '__syscall_ioctl',
  setitimer: '_setitimer_js',
};

/** How each syscall is wrapped, given the function the import holds. */
function wrapperFactories(
  deps: CloexecDeps
): Partial<Record<SyscallName, (syscall: GlueSyscall) => GlueSyscall>> {
  const { pty, timer } = deps;
  return {
    ...(timer ? { setitimer: (f: GlueSyscall) => kernelTimer(f, timer) } : {}),
    fcntl: (f) => cloexecFcntl(f, deps),
    pipe2: (f) => cloexecPipe2(f, deps),
    // dup3(old, new, flags); socket(domain, type, protocol); accept4(fd, addr, len, flags).
    dup3: (f) => cloexecByFlag(f, 2, deps),
    socket: (f) => cloexecByFlag(f, 1, deps),
    accept4: (f) => cloexecByFlag(f, 3, deps),
    ...(pty
      ? { ioctl: (f: GlueSyscall) => ptyIoctl(f, { fs: deps.fs, heap: deps.heap, kernel: pty }) }
      : {}),
  };
}

/**
 * `_setitimer_js(which, ms)` with ITIMER_REAL (0) on the kernel's clock
 * (`proc-alarm`); the virtual and profiling timers stay the glue's.
 */
function kernelTimer(setitimer: GlueSyscall, timer: { arm(ms: number): void }): GlueSyscall {
  return (which, ms) => {
    if (which !== 0) return setitimer(which, ms);
    timer.arm(ms ?? 0);
    return 0;
  };
}

/** The syscall an import is: the glue's function itself, else by its unminified name. */
function syscallOf(glue: GlueSyscalls, name: string, value: unknown): SyscallName | undefined {
  const names = Object.keys(IMPORT_NAMES) as SyscallName[];
  const own = names.find((key) => glue[key] !== undefined && glue[key] === value);
  if (own) return own;
  // An assertions build's Asyncify has already put every import behind a
  // checking wrapper of its own, so identity finds none: the name does.
  return typeof value === 'function'
    ? names.find((key) => glue[key] !== undefined && IMPORT_NAMES[key] === name)
    : undefined;
}

/**
 * Replace the glue's fcntl / pipe2 / dup3 / socket / accept4 / ioctl in
 * `imports` (the object the module is instantiated with) by FD_CLOEXEC- and
 * pty-aware versions. The import names may be minified, so they are found by
 * identity; where Asyncify already wrapped them (an assertions build, whose
 * names are not minified), by name, around what the import holds.
 */
export function wrapCloexecSyscalls(
  imports: WebAssembly.Imports,
  glue: GlueSyscalls | undefined,
  deps: CloexecDeps
): void {
  if (!glue) return;
  const factories = wrapperFactories(deps);
  const seen = new Set<object>();
  for (const namespace of Object.values(imports)) {
    if (!namespace || typeof namespace !== 'object' || seen.has(namespace)) continue;
    seen.add(namespace);
    for (const [name, value] of Object.entries(namespace)) {
      const key = syscallOf(glue, name, value);
      const wrap = key && factories[key];
      if (wrap) namespace[name] = wrap(value as GlueSyscall);
    }
  }
}

type AsyncImport = ((...args: number[]) => unknown) & { isAsync?: boolean };

/** A stream on a mount with its own `syncfs` (IDBFS, a program's persistent mount). */
function persistsItself(stream: ProcessStream): boolean {
  const type = stream.node.mount?.type as { syncfs?: unknown } | undefined;
  return typeof type?.syncfs === 'function';
}

/**
 * The errno a failed stream op carries: an ErrnoError's, or a SyscallError's
 * code. Anything else is a bug, and is rethrown, as Emscripten does.
 */
function errnoOf(err: unknown): number {
  const { errno, code } = (err ?? {}) as { errno?: unknown; code?: unknown };
  if (typeof errno === 'number') return errno;
  if (typeof code === 'string') return wasiErrno(code);
  throw err;
}

/**
 * Answer an Asyncify build's `fd_sync` synchronously. Emscripten marks it
 * async (`Asyncify.handleAsync`), so every fsync unwinds the stack, and the
 * fork glue allows only `fork` to suspend: git index-pack, which fsyncs the
 * pack it writes, failed with "unexpected Asyncify suspension (not a fork)".
 * Every file operation here is synchronous over the SAB bridge, so the
 * stream's own fsync answers at once; a mount that persists itself keeps
 * Emscripten's asynchronous one, which waits for its syncfs.
 */
export function syncFsync(imports: WebAssembly.Imports, fs: () => ProcessFs | undefined): void {
  for (const namespace of Object.values(imports)) {
    const original = namespace?.fd_sync as AsyncImport | undefined;
    if (typeof original !== 'function' || !original.isAsync) continue;
    namespace.fd_sync = (fd: number) => {
      const stream = fs()?.getStream(fd);
      if (!stream) return wasiErrno('EBADF');
      if (persistsItself(stream)) return original(fd);
      try {
        const result = stream.stream_ops.fsync?.(stream);
        return typeof result === 'number' ? result : 0;
      } catch (err) {
        return errnoOf(err);
      }
    };
  }
}

/**
 * fd_pread / fd_pwrite: (fd, iov, iovcnt, offset, pnum), the offset an i64
 * (BigInt), or legalized into signed (low, high) halves without WASM_BIGINT.
 */
type PositionedImport = (...args: Array<number | bigint>) => unknown;

interface PositionedDeps {
  fs: () => ProcessFs | undefined;
  /** The instance's memory, once it runs. */
  memory: () => ArrayBuffer | undefined;
  sys: Pick<ProcessSys, 'pread' | 'pwrite'>;
}

/** The iovecs at `iov`: [pointer, length] each. */
function iovecs(view: DataView, iov: number, iovcnt: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < iovcnt; i++) {
    out.push([view.getUint32(iov + i * 8, true), view.getUint32(iov + i * 8 + 4, true)]);
  }
  return out;
}

/** pread(2) into the iovecs at `at`; bytes read (short at end of file). */
function preadInto(
  buffer: ArrayBuffer,
  vecs: Array<[number, number]>,
  read: (len: number, at: number) => Uint8Array,
  at: number
): number {
  let total = 0;
  for (const [ptr, len] of vecs) {
    const bytes = read(len, at + total);
    new Uint8Array(buffer).set(bytes, ptr);
    total += bytes.length;
    if (bytes.length < len) break;
  }
  return total;
}

/** pwrite(2) of the iovecs at `at`; bytes written. */
function pwriteFrom(
  buffer: ArrayBuffer,
  vecs: Array<[number, number]>,
  write: (bytes: Uint8Array, at: number) => number,
  at: number
): number {
  let total = 0;
  for (const [ptr, len] of vecs) {
    const n = write(new Uint8Array(buffer, ptr, len).slice(), at + total);
    total += n;
    if (n < len) break;
  }
  return total;
}

/** An i64 argument: a BigInt, as signed, or a number. */
function i64(value: number | bigint | undefined): number {
  return typeof value === 'bigint' ? Number(BigInt.asIntN(64, value)) : Number(value);
}

/** A legalized i64 from its signed 32-bit halves. */
function i64Halves(low: number | bigint | undefined, high: number | bigint | undefined): number {
  return Number(high) * 2 ** 32 + (Number(low) >>> 0);
}

function positioned(original: PositionedImport, deps: PositionedDeps, mode: 'read' | 'write') {
  return (...args: Array<number | bigint>) => {
    const [fd, iov, iovcnt] = args.map(Number);
    const stream = deps.fs()?.getStream(fd);
    const kfd = stream?.sliccKernelFile ? stream.sliccKernelFd : undefined;
    const buffer = deps.memory();
    const { pread, pwrite } = deps.sys;
    if (kfd === undefined || !buffer || !pread || !pwrite) return original(...args);
    const split = args.length > 5;
    const offset = split ? i64Halves(args[3], args[4]) : i64(args[3]);
    const pnum = Number(args[split ? 5 : 4]);
    if (!Number.isSafeInteger(offset) || offset < 0) return wasiErrno('EINVAL');
    const view = new DataView(buffer);
    const vecs = iovecs(view, iov, iovcnt);
    let total: number;
    try {
      total =
        mode === 'read'
          ? preadInto(buffer, vecs, (len, at) => pread(kfd, len, at), offset)
          : pwriteFrom(buffer, vecs, (bytes, at) => pwrite(kfd, bytes, at), offset);
    } catch (err) {
      return errnoOf(err);
    }
    view.setUint32(pnum, total, true);
    return 0;
  };
}

/**
 * pread(2) / pwrite(2) on a descriptor backed by a kernel VFS file
 * description: at the requested offset, without moving the description's
 * shared one. Emscripten's fd_pread / fd_pwrite hand the offset to the
 * stream's read / write as a position, which such a stream cannot honour (its
 * read and write go at the shared offset): git, built NO_MMAP, reads packs
 * with pread and got another offset's bytes ("unknown object type 5 at offset
 * 12"). Other streams keep Emscripten's own.
 */
export function positionedIo(imports: WebAssembly.Imports, deps: PositionedDeps): void {
  for (const namespace of Object.values(imports)) {
    if (!namespace || typeof namespace !== 'object') continue;
    const { fd_pread: pread, fd_pwrite: pwrite } = namespace as {
      fd_pread?: unknown;
      fd_pwrite?: unknown;
    };
    if (typeof pread === 'function') {
      namespace.fd_pread = positioned(pread as PositionedImport, deps, 'read');
    }
    if (typeof pwrite === 'function') {
      namespace.fd_pwrite = positioned(pwrite as PositionedImport, deps, 'write');
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
