/**
 * `wasix-process.ts` — WASIX process calls over the kernel's children
 * (#3530 phase 5c): exec as spawn + exec (`proc-spawn`, then `proc-exec`,
 * which makes this process stand for the program it started), spawn with
 * its fd operations applied here, join as `proc-wait`, and the fork
 * handoff (`proc-fork`) the Asyncify driver calls once the stack is unwound.
 * Buffered files are handed to the kernel first, so whatever a child
 * inherits is a kernel description it shares.
 */
import type { ChildStdio, InheritedSlot } from '../children.js';
import { WASI_SIGNAL_TO_POSIX } from './wasi-abi.js';
import { normalize } from './wasi-files.js';
import { WasiExit, type WasiHost } from './wasi-host.js';
import type { AsyncifyDriver, WasiForkState } from './wasix-fork.js';

/** A spawn's fd operation (`__wasi_proc_spawn_fd_op_t`). */
export interface SpawnFdOp {
  cmd: 'close' | 'dup2' | 'open' | 'chdir' | 'fchdir';
  fd: number;
  srcFd: number;
  path: string;
  oflags: number;
  rightsWrite: boolean;
  append: boolean;
}

/** What a child is started with. */
export interface ChildRequest {
  name: string;
  argv: string[];
  /** Undefined: the process's own environment. */
  env?: Record<string, string>;
  search: boolean;
  path: string;
  ops?: readonly SpawnFdOp[];
}

/** `path` from `cwd` (an absolute one as is). */
function resolveFrom(cwd: string, path: string): string {
  return normalize(path.startsWith('/') ? path : `${cwd}/${path}`);
}

const POSIX_TO_WASI_SIGNAL: Readonly<Record<number, number>> = Object.fromEntries(
  Object.entries(WASI_SIGNAL_TO_POSIX).map(([wasi, posix]) => [posix, Number(wasi)])
);

/** musl's open(2) flags for a description an fd operation opens. */
const O_WRONLY = 0o1;
const O_RDWR = 0o2;
const O_APPEND = 0o2000;
const OFLAG_CREAT = 1;
const OFLAG_TRUNC = 8;

export class WasixProcess {
  constructor(
    private readonly host: WasiHost,
    private readonly driver: AsyncifyDriver
  ) {}

  private call(req: Parameters<WasiHost['o']['kernel']['call']>[0]): unknown {
    return this.host.o.kernel.call(req);
  }

  /** The process's environment as a child inherits it. */
  private environment(): Record<string, string> {
    return { ...this.host.o.env, PWD: this.host.cwd };
  }

  /** What `name` names: a PATH search on the VFS when asked (a program not found there keeps its bare name). */
  private locate(name: string, search: boolean, path: string): string {
    if (name.includes('/'))
      return name.startsWith('/') ? name : normalize(`${this.host.cwd}/${name}`);
    if (!search) return name;
    for (const dir of path.split(':')) {
      if (!dir) continue;
      const candidate = normalize(
        `${dir.startsWith('/') ? '' : `${this.host.cwd}/`}${dir}/${name}`
      );
      if (this.host.o.fs.exists(candidate)) return candidate;
    }
    return name;
  }

  /** The child's descriptors: this process's (not close-on-exec), then the spawn's fd operations. */
  private childFds(ops: readonly SpawnFdOp[]): {
    stdio: ChildStdio[];
    inherit: InheritedSlot[];
    cwd: string;
    opened: number[];
  } {
    const { fds } = this.host;
    fds.promoteFiles();
    const map = fds.inheritable();
    const opened: number[] = [];
    let cwd = this.host.cwd;
    try {
      for (const op of ops) {
        if (op.cmd === 'close') map.delete(op.fd);
        else if (op.cmd === 'dup2') {
          // A close-on-exec source still dups (dup2 clears the flag on the copy).
          const src =
            map.get(op.srcFd) ?? (fds.find(op.srcFd)?.type === 'kernel' ? op.srcFd : undefined);
          if (src === undefined) throw Object.assign(new Error('EBADF'), { code: 'EBADF' });
          map.set(op.fd, src);
        } else if (op.cmd === 'open') {
          const kfd = this.openFor(op, cwd);
          opened.push(kfd);
          map.set(op.fd, kfd);
        } else if (op.cmd === 'chdir') cwd = resolveFrom(cwd, op.path);
        else cwd = fds.dir(op.fd).path;
      }
    } catch (e) {
      // The spawn fails: what its earlier opens took goes back.
      for (const kfd of opened) this.host.o.kernel.sys.close(kfd);
      throw e;
    }
    const stdio: ChildStdio[] = [0, 1, 2].map((fd) => {
      const k = map.get(fd);
      return k === undefined ? { none: true } : { fd: k };
    });
    const inherit: InheritedSlot[] = [...map]
      .filter(([fd]) => fd > 2)
      .map(([fd, kernel]) => ({ fd, kernel }));
    return { stdio, inherit, cwd, opened };
  }

  /** A spawn's `open` fd operation (relative to the actions' `cwd` so far): a kernel VFS description of its own. */
  private openFor(op: SpawnFdOp, cwd: string): number {
    const path = resolveFrom(cwd, op.path);
    if (!this.host.o.fs.exists(path) && !(op.oflags & OFLAG_CREAT)) {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }
    const flags = (op.rightsWrite ? O_RDWR : 0) | (op.append ? O_APPEND : 0);
    return this.host.o.kernel.sys.openVfs(path, op.rightsWrite ? flags || O_WRONLY : 0, 0, {
      ...(op.oflags & OFLAG_TRUNC ? { contents: new Uint8Array(0) } : {}),
    });
  }

  /** Start a child (posix_spawn); its pid. */
  spawn(req: ChildRequest): number {
    const { stdio, inherit, cwd, opened } = this.childFds(req.ops ?? []);
    try {
      return this.call({
        op: 'proc-spawn',
        file: this.locate(req.name, req.search, req.path),
        argv: req.argv.length > 0 ? req.argv : [req.name],
        env: req.env ?? this.environment(),
        cwd,
        stdio,
        inherit,
      }) as number;
    } finally {
      for (const kfd of opened) this.host.o.kernel.sys.close(kfd);
    }
  }

  /** execve: run the program as this process and end with its status (a failed spawn returns its errno). */
  exec(req: ChildRequest): never {
    const pid = this.spawn(req);
    const [, status] = this.call({ op: 'proc-exec', pid }) as [number, number];
    const sig = status & 0x7f;
    throw new WasiExit(sig ? 128 + sig : (status >> 8) & 0xff);
  }

  /**
   * proc_join: wait for `pid` (the OptionPid at `pidPtr`, none: any child);
   * the status goes to `statusPtr` (`__wasi_join_status_t`: tag, then the
   * exit code or the signal).
   */
  join(pidPtr: number, flags: number, statusPtr: number): void {
    const v = this.host.mem.view();
    const pid = v.getUint8(pidPtr) === 1 ? v.getUint32(pidPtr + 4, true) : -1;
    this.host.mem.bytes(statusPtr, 6).fill(0);
    const [child, status] = this.call({ op: 'proc-wait', pid, nohang: (flags & 1) !== 0 }) as [
      number,
      number,
    ];
    if (child === 0) return; // WNOHANG and nothing yet: tag Nothing
    v.setUint8(pidPtr, 1);
    v.setUint32(pidPtr + 4, child, true);
    const sig = status & 0x7f;
    if (sig) {
      v.setUint8(statusPtr, 2);
      v.setUint8(statusPtr + 4, POSIX_TO_WASI_SIGNAL[sig] ?? sig);
    } else {
      v.setUint8(statusPtr, 1);
      v.setUint16(statusPtr + 2, (status >> 8) & 0xff, true);
    }
  }

  /**
   * proc_fork: once unwound, hand the kernel the memory copy, the Asyncify
   * data, the globals and the descriptor table (buffered files promoted
   * first, so parent and child share them); the child's pid.
   */
  fork(pidPtr: number): number | undefined {
    const back = this.driver.rewound();
    if (back !== undefined) {
      this.host.mem.view().setUint32(pidPtr, back, true);
      return undefined;
    }
    return this.driver.fork((asyncifyData, globals, forkSp) => {
      const { fds } = this.host;
      fds.promoteFiles();
      const memory = this.host.mem.bytes(0, this.host.mem.size()).slice();
      const wasi: WasiForkState = {
        asyncifyData,
        globals,
        fds: fds.snapshot(),
        cloexec: [...fds.cloexec],
        cwd: this.host.cwd,
        ...(fds.isShared ? { shared: true as const } : {}),
        setjmps: this.driver.setjmps(),
      };
      return this.call({
        op: 'proc-fork',
        state: { memory, currData: 0, forkSp, callStackNames: [], ppid: this.host.o.pid, wasi },
      }) as number;
    });
  }
}
