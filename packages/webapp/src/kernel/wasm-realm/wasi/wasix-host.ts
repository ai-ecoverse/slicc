/**
 * `wasix-host.ts` — the `wasix_32v1` imports over the wasm-realm kernel
 * (#3530 phase 5c), on top of the preview1 host (`wasi-host.ts`):
 *
 * - libc start-up: the signal table (empty), `callback_signal`,
 *   `proc_exit2`, `getcwd` / `chdir`, `proc_id` / `proc_parent`;
 * - descriptors: `fd_dup` / `fd_dup2` (F_DUPFD), `fd_pipe`,
 *   `fd_fdflags_get` / `_set` (FD_CLOEXEC), `path_open2`;
 * - processes: `proc_fork` and setjmp / longjmp (`wasix-fork.ts`), exec,
 *   spawn and join (`wasix-process.ts`);
 * - `futex_*` on the shared memory, `tty_get` / `tty_set`, `proc_signal`.
 *
 * **Signals**: the kernel applies every signal's default action itself
 * (a ^C'd child ends WIFSIGNALED, 130). wasix-libc keeps its handlers in its
 * own memory and never tells the host which it catches, and its own default
 * actions `abort()` (terminate, stop) or call `SIG_IGN` as a function
 * (ignore) — so nothing is delivered to `__wasm_signal`, and handlers do not
 * run.
 *
 * **Versions**: WASIX renames a call when its ABI changes (`proc_exec3`,
 * `proc_exec4`, `proc_spawn2`, `proc_spawn3`, `path_open2`, `proc_exit2`), and
 * binaries built against different wasix-libc releases import different
 * generations. {@link COMPAT} lists the ones served here; any other
 * `wasix_32v1` import answers ENOSYS.
 */
import { E, FDFLAGS, WASI_SIGNAL_TO_POSIX, wasiErrnoOf } from './wasi-abi.js';
import { WasiError } from './wasi-files.js';
import { WasiExit, type WasiFunction, type WasiHost, wrap } from './wasi-host.js';
import { MAIN_TID, ThreadExit, type WasiThreads } from './wasi-threads.js';
import type { AsyncifyDriver } from './wasix-fork.js';
import { DlError, type WasixLinker } from './wasix-linker.js';
import { type SpawnFdOp, WasixProcess } from './wasix-process.js';

const FDFLAGSEXT_CLOEXEC = 1;
const SPAWN_OP_SIZE = 56;
const SPAWN_OPS = ['close', 'dup2', 'open', 'chdir', 'fchdir'] as const;
const RIGHTS_FD_WRITE = 1n << 6n;
// musl's termios bits (the kernel's tty keeps Linux's).
const ICANON = 0o2;
const ECHO = 0o10;

/** The WASIX calls served, by generation: each name an ABI (renamed when it changes). */
export const COMPAT: Readonly<Record<string, readonly string[]>> = {
  exit: ['proc_exit2'],
  exec: ['proc_exec', 'proc_exec2', 'proc_exec3', 'proc_exec4'],
  spawn: ['proc_spawn2', 'proc_spawn3'],
  open: ['path_open2'],
  dup: ['fd_dup', 'fd_dup2'],
};

export class WasixHost {
  private readonly process: WasixProcess;
  /** The process's threads (a module with a shared memory can have them). */
  threads: WasiThreads | undefined;
  /** The dynamic linker of a position-independent (PIE) program (5g). */
  linker: WasixLinker | undefined;

  constructor(
    private readonly host: WasiHost,
    private readonly driver: AsyncifyDriver,
    module?: WebAssembly.Module
  ) {
    this.process = new WasixProcess(host, driver);
    // A libc without fd_fdflags_set cannot mark fds close-on-exec, and takes them all to be.
    if (module && !WebAssembly.Module.imports(module).some((i) => i.name === 'fd_fdflags_set')) {
      host.fds.implicitCloexec = true;
    }
  }

  private get mem() {
    return this.host.mem;
  }

  /** A (ptr, len) string, without a trailing NUL some callers count. */
  private str(ptr: number, len: number): string {
    const s = this.mem.string(ptr, len);
    return s.endsWith('\0') ? s.slice(0, -1) : s;
  }

  /** `count` pointers to NUL-terminated strings at `ptr`. */
  private cStrings(ptr: number, count: number): string[] {
    const v = this.mem.view();
    return Array.from({ length: count }, (_, i) =>
      this.mem.cString(v.getUint32(ptr + i * 4, true))
    );
  }

  /** `KEY=value` entries as an environment (none: inherit). */
  /** proc_exec / proc_exec2: exec, or exit with the failure's errno. */
  private execOrExit(n: number, nl: number, a: number, al: number, e: number, el: number): never {
    try {
      return this.process.exec({
        name: this.str(n, nl),
        argv: WasixHost.lines(this.str(a, al)),
        env: WasixHost.env(e === 0 ? undefined : WasixHost.lines(this.str(e, el))),
        search: false,
        path: '',
      });
    } catch (err) {
      if (err instanceof WasiExit) throw err;
      const code = err instanceof WasiError ? err.code : (err as { code?: unknown } | null)?.code;
      throw new WasiExit(wasiErrnoOf(typeof code === 'string' ? code : 'ENOEXEC'));
    }
  }

  private static env(entries: readonly string[] | undefined): Record<string, string> | undefined {
    if (!entries) return undefined;
    const env: Record<string, string> = {};
    for (const line of entries) {
      const eq = line.indexOf('=');
      if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
    }
    return env;
  }

  /** Line-feed separated entries (the v2/v3 calls). */
  private static lines(text: string): string[] {
    return text.split('\n').filter((line, i, all) => line !== '' || i < all.length - 1);
  }

  private spawnOps(ptr: number, count: number): SpawnFdOp[] {
    const v = this.mem.view();
    return Array.from({ length: count }, (_, i) => {
      const p = ptr + i * SPAWN_OP_SIZE;
      const cmd = SPAWN_OPS[v.getUint8(p)];
      if (!cmd) throw new WasiError('EINVAL');
      return {
        cmd,
        fd: v.getUint32(p + 4, true),
        srcFd: v.getUint32(p + 8, true),
        path: this.str(v.getUint32(p + 12, true), v.getUint32(p + 16, true)),
        oflags: v.getUint16(p + 24, true),
        rightsWrite: (v.getBigUint64(p + 32, true) & RIGHTS_FD_WRITE) !== 0n,
        append: (v.getUint16(p + 48, true) & FDFLAGS.APPEND) !== 0,
      };
    });
  }

  /** Every `wasix_32v1` import served, errors mapped to WASI errnos. */
  imports(): Record<string, WasiFunction> {
    return wrap({
      ...this.startupImports(),
      ...this.fdImports(),
      ...this.processImports(),
      ...this.threadImports(),
      ...this.dlImports(),
    });
  }

  /**
   * The `wasi_snapshot_preview1` calls a WASIX program means differently:
   * `fd_renumber` is dup2 (Wasmer's `dup2_at`), so `from` stays open; and a
   * preopen does not close (as in Wasmer: a child's close-every-fd before
   * exec — Python's `close_fds` — must not take its paths away).
   */
  preview1(): Record<string, WasiFunction> {
    const { fds } = this.host;
    return wrap({
      fd_renumber: (from: number, to: number) => void fds.renumber(from, to, true),
      fd_close: (fd: number) => {
        const e = fds.get(fd);
        if (e.type !== 'dir' || !e.preopen) fds.close(fd);
      },
    });
  }

  private startupImports(): Record<string, WasiFunction> {
    const { host, mem } = this;
    return {
      proc_exit2: (code: number) => {
        throw new WasiExit(code);
      },
      // No dispositions to hand down: the kernel keeps them.
      proc_signals_sizes_get: (out: number) => void mem.view().setUint32(out, 0, true),
      proc_signals_get: () => E.SUCCESS,
      callback_signal: () => undefined,
      proc_raise_interval: () => E.NOTSUP,
      proc_id: (out: number) => void mem.view().setUint32(out, host.o.pid, true),
      proc_parent: (pid: number, out: number) => {
        if (pid !== 0 && pid !== host.o.pid) throw new WasiError('ESRCH');
        mem.view().setUint32(out, host.o.ppid ?? 1, true);
      },
      getcwd: (buf: number, lenPtr: number) => {
        const bytes = new TextEncoder().encode(host.cwd);
        const max = mem.view().getUint32(lenPtr, true);
        mem.view().setUint32(lenPtr, bytes.length, true);
        if (bytes.length > max) return E.RANGE;
        mem.bytes(buf, bytes.length).set(bytes);
        if (bytes.length < max) mem.view().setUint8(buf + bytes.length, 0);
        return E.SUCCESS;
      },
      chdir: (ptr: number, len: number) => {
        const path = host.fds.resolve(3, this.str(ptr, len));
        if (!host.o.fs.stat(path).isDirectory) throw new WasiError('ENOTDIR');
        host.fds.chdir(path);
      },
    };
  }

  private fdImports(): Record<string, WasiFunction> {
    const { host, mem } = this;
    const preview1 = host.imports() as Record<string, (...a: unknown[]) => number>;
    return {
      fd_dup: (fd: number, out: number) =>
        void mem.view().setUint32(out, host.fds.dup(fd, 0, false), true),
      fd_dup2: (fd: number, min: number, cloexec: number, out: number) =>
        void mem.view().setUint32(out, host.fds.dup(fd, min, cloexec !== 0), true),
      fd_pipe: (rPtr: number, wPtr: number) => {
        const [r, w] = host.fds.pipe();
        mem.view().setUint32(rPtr, r, true);
        mem.view().setUint32(wPtr, w, true);
      },
      fd_fdflags_get: (fd: number, out: number) => {
        host.fds.get(fd);
        mem.view().setUint16(out, host.fds.cloexec.has(fd) ? FDFLAGSEXT_CLOEXEC : 0, true);
      },
      fd_fdflags_set: (fd: number, flags: number) =>
        void host.fds.setCloexec(fd, (flags & FDFLAGSEXT_CLOEXEC) !== 0),
      path_open2: (
        dirfd: number,
        lookup: number,
        p: number,
        l: number,
        oflags: number,
        rights: bigint,
        inheriting: bigint,
        fdflags: number,
        fdflagsext: number,
        out: number
      ) => {
        const r = preview1.path_open(dirfd, lookup, p, l, oflags, rights, inheriting, fdflags, out);
        if (r === E.SUCCESS && fdflagsext & FDFLAGSEXT_CLOEXEC)
          host.fds.setCloexec(mem.view().getUint32(out, true), true);
        return r;
      },
      tty_get: (ptr: number) => void this.ttyGet(ptr),
      tty_set: (ptr: number) => void this.ttySet(ptr),
    };
  }

  private processImports(): Record<string, WasiFunction> {
    const { mem, process } = this;
    return {
      proc_fork: (_copy: number, pidPtr: number) => process.fork(pidPtr),
      stack_checkpoint: (snapPtr: number, retPtr: number) => {
        const back = this.driver.rewound();
        if (back === undefined) return this.driver.checkpoint(snapPtr, retPtr);
        mem.view().setBigUint64(retPtr, BigInt(back), true);
        return E.SUCCESS;
      },
      stack_restore: (snapPtr: number, val: bigint) => void this.driver.restore(snapPtr, val),
      proc_join: (pidPtr: number, flags: number, statusPtr: number) =>
        void process.join(pidPtr, flags, statusPtr),
      proc_signal: (pid: number, sig: number) => {
        // Signal 0 only asks whether the process exists.
        const posix = sig === 0 ? 0 : WASI_SIGNAL_TO_POSIX[sig];
        if (posix === undefined) throw new WasiError('EINVAL');
        this.host.o.kernel.call({ op: 'proc-kill', pid, sig: posix });
      },
      // The first generations never return: a failed exec ends the process
      // with its errno (as in Wasmer), no PATH search, envs null: inherit.
      proc_exec: (n: number, nl: number, a: number, al: number) =>
        this.execOrExit(n, nl, a, al, 0, 0),
      proc_exec2: (n: number, nl: number, a: number, al: number, e: number, el: number) =>
        this.execOrExit(n, nl, a, al, e, el),
      // name, args (lines), envs (lines), search, PATH
      proc_exec3: (
        n: number,
        nl: number,
        a: number,
        al: number,
        e: number,
        el: number,
        search: number,
        p: number,
        pl: number
      ) =>
        process.exec({
          name: this.str(n, nl),
          argv: WasixHost.lines(this.str(a, al)),
          env: WasixHost.env(WasixHost.lines(this.str(e, el))),
          search: search !== 0,
          path: this.str(p, pl),
        }),
      // name, args (array), envs (array, null: inherit), search, PATH
      proc_exec4: (
        n: number,
        nl: number,
        a: number,
        ac: number,
        e: number,
        ec: number,
        search: number,
        p: number,
        pl: number
      ) =>
        process.exec({
          name: this.str(n, nl),
          argv: this.cStrings(a, ac),
          env: WasixHost.env(e === 0 ? undefined : this.cStrings(e, ec)),
          search: search !== 0,
          path: this.str(p, pl),
        }),
      proc_spawn2: (...args: number[]) => {
        const [n, nl, a, al, e, el, ops, opc, , , search, p, pl, out] = args;
        const pid = process.spawn({
          name: this.str(n, nl),
          argv: WasixHost.lines(this.str(a, al)),
          env: WasixHost.env(WasixHost.lines(this.str(e, el))),
          search: search !== 0,
          path: this.str(p, pl),
          ops: this.spawnOps(ops, opc),
        });
        mem.view().setUint32(out, pid, true);
      },
      proc_spawn3: (...args: number[]) => {
        const [n, nl, a, ac, e, ec, ops, opc, , , search, p, pl, out] = args;
        const pid = process.spawn({
          name: this.str(n, nl),
          argv: this.cStrings(a, ac),
          env: WasixHost.env(e === 0 ? undefined : this.cStrings(e, ec)),
          search: search !== 0,
          path: this.str(p, pl),
          ops: this.spawnOps(ops, opc),
        });
        mem.view().setUint32(out, pid, true);
      },
    };
  }

  /**
   * dlopen / dlsym (5g): the linker of a PIE program. A failure writes its
   * message into the caller's buffer (NUL-terminated, dlerror's) and answers
   * an errno the libc only tests for non-zero.
   */
  private dlImports(): Record<string, WasiFunction> {
    const { mem, host } = this;
    const failed = (message: string, buf: number, len: number): number => {
      if (len > 0) {
        const bytes = new TextEncoder().encode(message).subarray(0, len - 1);
        mem.bytes(buf, bytes.length).set(bytes);
        mem.view().setUint8(buf + bytes.length, 0);
      }
      return E.NOEXEC;
    };
    const linked = <T>(
      buf: number,
      len: number,
      op: (l: WasixLinker) => T,
      out: (v: T) => void
    ): number => {
      if (!this.linker) return failed('not a dynamically-linked program', buf, len);
      try {
        out(op(this.linker));
        return E.SUCCESS;
      } catch (e) {
        if (e instanceof DlError) return failed(e.message, buf, len);
        throw e;
      }
    };
    return {
      // path (null: the main module, handle 0), flags, err buf, LD_LIBRARY_PATH → handle
      dlopen: (
        p: number,
        pl: number,
        _flags: number,
        buf: number,
        len: number,
        lp: number,
        ll: number,
        out: number
      ) => {
        if (p === 0) {
          mem.view().setUint32(out, 0, true);
          return E.SUCCESS;
        }
        return linked(
          buf,
          len,
          (l) => l.open(this.str(p, pl), host.cwd, lp === 0 ? [] : this.str(lp, ll).split(':')),
          (h) => void mem.view().setUint32(out, h, true)
        );
      },
      // handle (0: everything), symbol, err buf → a table slot or an address
      dlsym: (handle: number, s: number, sl: number, buf: number, len: number, out: number) =>
        linked(
          buf,
          len,
          (l) => l.symbol(handle, this.str(s, sl)),
          (v) => void mem.view().setUint32(out, v, true)
        ),
      dl_invalid_handle: (handle: number) =>
        handle !== 0 && this.linker && !this.linker.invalid(handle) ? E.SUCCESS : E.NOEXEC,
    };
  }

  private threadImports(): Record<string, WasiFunction> {
    const { mem, host } = this;
    const i32 = () => new Int32Array(mem.view().buffer);
    return {
      thread_id: (out: number) =>
        void mem.view().setUint32(out, this.threads?.tid ?? MAIN_TID, true),
      thread_parallelism: (out: number) =>
        void mem.view().setUint32(out, this.threads?.parallelism() ?? 1, true),
      // Another thread's exit is its own; the main thread's is the process's.
      thread_exit: (code: number) => {
        if (this.threads && this.threads.tid !== MAIN_TID) throw new ThreadExit();
        throw new WasiExit(code);
      },
      // A signal to a thread is the process's: the kernel applies its default action.
      thread_signal: (tid: number, sig: number) => {
        if (!(this.threads?.known(tid) ?? tid === MAIN_TID)) throw new WasiError('ESRCH');
        const posix = WASI_SIGNAL_TO_POSIX[sig];
        if (posix === undefined) throw new WasiError('EINVAL');
        host.o.kernel.call({ op: 'proc-kill', pid: host.o.pid, sig: posix });
      },
      // start_ptr → wasi_thread_start(tid, start_ptr) in a new worker; EAGAIN past the cap.
      thread_spawn_v2: (startPtr: number, tidPtr: number) => {
        if (!this.threads) return E.NOTSUP;
        const tid = this.threads.spawn(startPtr);
        if (tid < 0) return E.AGAIN;
        mem.view().setUint32(tidPtr, tid, true);
        return E.SUCCESS;
      },
      futex_wait: (ptr: number, expected: number, timeoutPtr: number, wokenPtr: number) => {
        const v = mem.view();
        const timed = timeoutPtr !== 0 && v.getUint8(timeoutPtr) === 1;
        const ms = timed
          ? Number(v.getBigUint64(timeoutPtr + 8, true)) / 1e6
          : Number.POSITIVE_INFINITY;
        // As Wasmer answers: woken unless it timed out (a changed value counts as woken).
        v.setUint8(
          wokenPtr,
          Atomics.wait(i32(), ptr >> 2, expected | 0, ms) === 'timed-out' ? 0 : 1
        );
      },
      // Woken whether or not anyone waited (Wasmer's answer): wasix-libc retries
      // a wake that reports otherwise, and would spin on an uncontended unlock.
      futex_wake: (ptr: number, wokenPtr: number) => {
        Atomics.notify(i32(), ptr >> 2, 1);
        mem.view().setUint8(wokenPtr, 1);
      },
      futex_wake_all: (ptr: number, wokenPtr: number) => {
        Atomics.notify(i32(), ptr >> 2);
        mem.view().setUint8(wokenPtr, 1);
      },
    };
  }

  /** The first of fds 0-2 that is a terminal, if any. */
  private ttyFd(): number | undefined {
    for (const fd of [0, 1, 2]) {
      const e = this.host.fds.find(fd);
      if (e?.type === 'kernel' && this.host.fds.kind(fd, e) === 'tty') return fd;
    }
    return undefined;
  }

  /** tty_get: `__wasi_tty_t` (cols, rows, width, height, the stdio ttys, echo, line buffering). */
  private ttyGet(ptr: number): void {
    const { host, mem } = this;
    const v = mem.view();
    mem.bytes(ptr, 24).fill(0);
    const fd = this.ttyFd();
    const isTty = (n: number) => {
      const e = host.fds.find(n);
      return e?.type === 'kernel' && host.fds.kind(n, e) === 'tty' ? 1 : 0;
    };
    v.setUint8(ptr + 16, isTty(0));
    v.setUint8(ptr + 17, isTty(1));
    v.setUint8(ptr + 18, isTty(2));
    if (fd === undefined) {
      v.setUint32(ptr, 80, true);
      v.setUint32(ptr + 4, 24, true);
      return;
    }
    const [rows, cols] = host.o.kernel.sys.winsize?.(fd) ?? [24, 80];
    const termios = host.o.kernel.sys.tcgets?.(fd);
    v.setUint32(ptr, cols, true);
    v.setUint32(ptr + 4, rows, true);
    v.setUint8(ptr + 19, termios && termios.c_lflag & ECHO ? 1 : 0);
    v.setUint8(ptr + 20, termios && termios.c_lflag & ICANON ? 1 : 0);
  }

  /** tty_set: echo and line buffering onto the terminal's termios. */
  private ttySet(ptr: number): void {
    const fd = this.ttyFd();
    if (fd === undefined) throw new WasiError('ENOTTY');
    const { sys } = this.host.o.kernel;
    const termios = sys.tcgets?.(fd);
    if (!termios) throw new WasiError('ENOTTY');
    const v = this.mem.view();
    let lflag = termios.c_lflag & ~(ECHO | ICANON);
    if (v.getUint8(ptr + 19)) lflag |= ECHO;
    if (v.getUint8(ptr + 20)) lflag |= ICANON;
    sys.tcsets?.(fd, { ...termios, c_lflag: lflag });
  }
}

/** Whether a module speaks WASIX (it imports `wasix_32v1`). */
export function isWasix(module: WebAssembly.Module): boolean {
  return WebAssembly.Module.imports(module).some((i) => i.module === 'wasix_32v1');
}
