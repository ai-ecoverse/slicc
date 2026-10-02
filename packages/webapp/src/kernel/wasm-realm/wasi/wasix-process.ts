import type { ChildStdio, InheritedSlot } from '../children.js';
import { WASI_SIGNAL_TO_POSIX } from './wasi-abi.js';
import { normalize } from './wasi-files.js';
import { WasiExit, type WasiHost } from './wasi-host.js';
import type { AsyncifyDriver, WasiForkState } from './wasix-fork.js';

export interface SpawnFdOp {
  cmd: 'close' | 'dup2' | 'open' | 'chdir' | 'fchdir';
  fd: number;
  srcFd: number;
  path: string;
  oflags: number;
  rightsWrite: boolean;
  append: boolean;
}

export interface ChildRequest {
  name: string;
  argv: string[];

  env?: Record<string, string>;
  search: boolean;
  path: string;
  ops?: readonly SpawnFdOp[];
}

function resolveFrom(cwd: string, path: string): string {
  return normalize(path.startsWith('/') ? path : `${cwd}/${path}`);
}

const POSIX_TO_WASI_SIGNAL: Readonly<Record<number, number>> = Object.fromEntries(
  Object.entries(WASI_SIGNAL_TO_POSIX).map(([wasi, posix]) => [posix, Number(wasi)])
);

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

  private environment(): Record<string, string> {
    return { ...this.host.o.env, PWD: this.host.cwd };
  }

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

  private childFds(ops: readonly SpawnFdOp[]): {
    stdio: ChildStdio[];
    inherit: InheritedSlot[];
    cwd: string;
    opened: number[];
  } {
    const { fds } = this.host;
    fds.promoteFiles();
    const map = fds.inheritable();

    const nulls = new Set<number>();
    const opened: number[] = [];
    let cwd = this.host.cwd;
    try {
      for (const op of ops) cwd = this.applyFdOp(op, { map, nulls, opened }, cwd);
    } catch (e) {
      for (const kfd of opened) this.host.o.kernel.sys.close(kfd);
      throw e;
    }
    const stdio: ChildStdio[] = [0, 1, 2].map((fd) => {
      const k = map.get(fd);
      return k === undefined ? { none: true } : { fd: k };
    });
    const inherit: InheritedSlot[] = [
      ...[...map].filter(([fd]) => fd > 2).map(([fd, kernel]) => ({ fd, kernel })),
      ...[...nulls].filter((fd) => fd > 2).map((fd) => ({ fd, device: 'null' as const })),
    ];
    return { stdio, inherit, cwd, opened };
  }

  private applyFdOp(
    op: SpawnFdOp,
    slots: { map: Map<number, number>; nulls: Set<number>; opened: number[] },
    cwd: string
  ): string {
    const { map, nulls, opened } = slots;
    const { fds } = this.host;
    const point = (fd: number, kfd: number | undefined) => {
      if (kfd === undefined) {
        map.delete(fd);
        nulls.add(fd);
      } else {
        map.set(fd, kfd);
        nulls.delete(fd);
      }
    };
    if (op.cmd === 'close') {
      map.delete(op.fd);
      nulls.delete(op.fd);
    } else if (op.cmd === 'dup2' && nulls.has(op.srcFd)) point(op.fd, undefined);
    else if (op.cmd === 'dup2') {
      const src =
        map.get(op.srcFd) ?? (fds.find(op.srcFd)?.type === 'kernel' ? op.srcFd : undefined);
      if (src === undefined) throw Object.assign(new Error('EBADF'), { code: 'EBADF' });
      point(op.fd, src);
    } else if (op.cmd === 'open' && resolveFrom(cwd, op.path) === '/dev/null') {
      point(op.fd, undefined);
    } else if (op.cmd === 'open') {
      const kfd = this.openFor(op, cwd);
      opened.push(kfd);
      point(op.fd, kfd);
    } else if (op.cmd === 'chdir') return resolveFrom(cwd, op.path);
    else return fds.dir(op.fd).path;
    return cwd;
  }

  private openFor(op: SpawnFdOp, cwd: string): number {
    const path = resolveFrom(cwd, op.path);
    const create = (op.oflags & OFLAG_CREAT) !== 0;
    if (!create && !this.host.o.fs.exists(path)) {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }
    const flags = (op.rightsWrite ? O_RDWR : 0) | (op.append ? O_APPEND : 0);

    return this.host.o.kernel.sys.openVfs(path, op.rightsWrite ? flags || O_WRONLY : 0, 0, {
      ...(create ? { create } : {}),
      ...(op.oflags & OFLAG_TRUNC ? { truncate: true } : {}),
    });
  }

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

      this.host.o.fs.invalidate?.();
    }
  }

  exec(req: ChildRequest): never {
    const pid = this.spawn(req);
    const [, status] = this.call({ op: 'proc-exec', pid }) as [number, number];
    const sig = status & 0x7f;
    throw new WasiExit(sig ? 128 + sig : (status >> 8) & 0xff);
  }

  join(pidPtr: number, flags: number, statusPtr: number): void {
    const v = this.host.mem.view();
    const pid = v.getUint8(pidPtr) === 1 ? v.getUint32(pidPtr + 4, true) : -1;
    this.host.mem.bytes(statusPtr, 6).fill(0);
    const [child, status] = this.call({ op: 'proc-wait', pid, nohang: (flags & 1) !== 0 }) as [
      number,
      number,
    ];
    if (child === 0) return;

    this.host.o.fs.invalidate?.();
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
