import type {
  SyncFsBridgeStat,
  SyncFsPosixBridge,
} from '../../../../src/kernel/realm/sync-fs-xhr-bridge.js';
import type { HeldMeta, KernelFdKind } from '../../../../src/kernel/wasm-realm/fd-table.js';
import type { ProcessSys } from '../../../../src/kernel/wasm-realm/kernel-streams.js';
import type { WasmSyscall } from '../../../../src/kernel/wasm-realm/process.js';
import type { WasiKernel } from '../../../../src/kernel/wasm-realm/wasi/wasi-fds.js';

export function posix(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

interface FakeFd {
  kind: KernelFdKind;

  input: Uint8Array[];
  output: Uint8Array[];

  broken?: boolean;

  ready?: boolean;

  offset?: number;

  pending?: string[][];

  shut?: number[];

  hangup?: boolean;

  drained?: string;

  reads?: number[];

  path?: string;
  data?: Uint8Array;
  meta?: HeldMeta;
  flags?: number;
  cloexec?: boolean;
}

export class FakeKernel implements WasiKernel {
  readonly table = new Map<number, FakeFd>();
  readonly calls: WasmSyscall[] = [];
  readonly killed: Array<[number, number]> = [];

  readonly opened: string[] = [];

  readonly openedOpts: Array<object | undefined> = [];

  waitResult: [number, number] = [0, 0];
  tty = false;

  constructor() {
    for (const fd of [0, 1, 2]) this.add(fd, 'stream');
  }

  add(fd: number, kind: KernelFdKind, input: string[] = []): FakeFd {
    const entry: FakeFd = {
      kind,
      input: input.map((s) => new TextEncoder().encode(s)),
      output: [],
    };
    this.table.set(fd, entry);
    return entry;
  }

  out(fd: number): string {
    return (this.table.get(fd)?.output ?? []).map((b) => new TextDecoder().decode(b)).join('');
  }

  private get(fd: number): FakeFd {
    const e = this.table.get(fd);
    if (!e) throw posix('EBADF');
    return e;
  }

  private info(fd: number) {
    const e = this.get(fd);
    return {
      tty: e.kind === 'tty',
      kind: e.kind,
      ...(e.meta ? { meta: e.meta } : {}),
      ...(e.flags !== undefined ? { flags: e.flags } : {}),
      ...(e.cloexec ? { cloexec: true as const } : {}),
    };
  }

  private free(min: number): number {
    let fd = min;
    while (this.table.has(fd)) fd++;
    return fd;
  }

  readonly sys: ProcessSys = {
    read: (fd, max, opts) => {
      const e = this.get(fd);
      (e.reads ??= []).push(max);
      const chunk = e.input.shift();
      if (!chunk && e.drained) throw posix(e.drained);
      if (!chunk) {
        if (opts?.nonblock && e.kind === 'stream' && e.ready === false) throw posix('EAGAIN');
        return new Uint8Array(0);
      }
      if (chunk.length > max) e.input.unshift(chunk.subarray(max));
      return chunk.subarray(0, max);
    },
    write: (fd, bytes) => {
      const e = this.get(fd);
      if (e.broken) throw posix('EPIPE');
      e.output.push(bytes.slice());
      return bytes.length;
    },
    close: (fd) => {
      this.get(fd);
      this.table.delete(fd);
    },
    pipe: () => {
      const r = this.free(3);
      this.add(r, 'stream');
      const w = this.free(3);
      this.add(w, 'stream');
      return [r, w];
    },
    poll: () => ({ readable: true, writable: true, hangup: false }),
    openVfs: (path, _flags, _position, opts) => {
      this.opened.push(path);
      this.openedOpts.push(opts);
      const fd = this.free(3);
      this.add(fd, 'file').path = path;
      return fd;
    },
    seek: (fd, offset) => {
      const e = this.get(fd);
      e.offset = offset;
      return offset;
    },
    flush: (fd) => void this.get(fd),
    pread: (fd, max, at) => (this.get(fd).data ?? new Uint8Array(0)).slice(at, at + max),
    openTty: () => {
      if (!this.tty) throw posix('ENXIO');
      const fd = this.free(3);
      this.add(fd, 'tty');
      return fd;
    },
  };

  call(req: WasmSyscall): unknown {
    this.calls.push(req);
    switch (req.op) {
      case 'fd-reserve': {
        if (req.fd !== undefined && this.table.has(req.fd)) throw posix('EBADF');
        const fd = req.fd ?? this.free(req.min ?? 3);
        this.add(fd, 'held').meta = req.meta;
        return fd;
      }
      case 'fd-meta':
        this.get(req.fd).meta = req.meta;
        return undefined;
      case 'fd-setfl':
        this.get(req.fd).flags = req.flags;
        return undefined;
      case 'fd-cloexec':
        this.get(req.fd).cloexec = req.on;
        return undefined;
      case 'fd-list':
        return [...this.table.keys()].sort((a, b) => a - b).map((fd) => ({ fd, ...this.info(fd) }));
      case 'fd-dup': {
        const fd = this.free(req.min ?? 3);
        this.table.set(fd, this.get(req.fd));
        return fd;
      }
      case 'fd-renumber':
        this.table.set(req.to, this.get(req.from));
        if (!req.keep) this.table.delete(req.from);
        return undefined;
      case 'proc-spawn':
        throw posix('ENOENT');
      case 'proc-wait':
        return this.waitResult;
      case 'fd-info':
        return this.info(req.fd);
      case 'fd-select': {
        const hung = [...req.read, ...req.write].filter((fd) => this.table.get(fd)?.hangup);
        return {
          read: req.read.filter((fd) => this.table.get(fd)?.ready !== false),
          write: req.write.filter((fd) => this.table.get(fd)?.ready !== false),
          ...(hung.length > 0 ? { hangup: hung } : {}),
        };
      }
      case 'sock-accept': {
        const conn = this.get(req.fd).pending?.shift();
        if (!conn) throw posix(req.nonblock ? 'EAGAIN' : 'EINTR');
        const fd = this.free(3);
        this.add(fd, 'socket', conn);
        return { fd, peer: { family: 'inet', host: '127.0.0.1', port: 40000 } };
      }
      case 'sock-shutdown':
        (this.get(req.fd).shut ??= []).push(req.how);
        return undefined;
      case 'proc-kill':
        this.killed.push([req.pid, req.sig]);
        return undefined;
      case 'fd-pwrite': {
        const e = this.get(req.fd);
        const old = e.data ?? new Uint8Array(0);
        e.data = new Uint8Array(Math.max(old.length, req.offset + req.body.length));
        e.data.set(old);
        e.data.set(req.body, req.offset);
        return req.body.length;
      }
      case 'fd-resize': {
        const e = this.get(req.fd);
        const old = e.data ?? new Uint8Array(0);
        e.data = new Uint8Array(req.size);
        e.data.set(old.subarray(0, req.size));
        return undefined;
      }
      case 'fd-vfs-stat': {
        const e = this.get(req.fd);
        return { path: e.path, size: e.data?.length ?? 0 };
      }
      case 'proc-alarm':
        return undefined;
      case 'fd-path-flush':
      case 'fd-path-unlinking':
      case 'fd-path-unlinked':
      case 'fd-path-renamed':
        return undefined;
      default:
        throw posix('ENOSYS');
    }
  }
}

type Node =
  | { type: 'file'; data: Uint8Array; mtimeMs: number; ino: number }
  | { type: 'dir'; mtimeMs: number }
  | { type: 'link'; target: string };

export class FakeFs implements SyncFsPosixBridge {
  readonly nodes = new Map<string, Node>([['/', { type: 'dir', mtimeMs: 0 }]]);
  readonly ops: string[] = [];
  private ino = 100;

  dir(path: string): this {
    this.nodes.set(path, { type: 'dir', mtimeMs: 1000 });
    return this;
  }

  file(path: string, text: string): this {
    this.nodes.set(path, {
      type: 'file',
      data: new TextEncoder().encode(text),
      mtimeMs: 2000,
      ino: this.ino++,
    });
    return this;
  }

  text(path: string): string {
    const n = this.nodes.get(path);
    return n?.type === 'file' ? new TextDecoder().decode(n.data) : '';
  }

  private node(path: string, follow = true): Node {
    const n = this.nodes.get(path);
    if (!n) throw posix('ENOENT');
    if (follow && n.type === 'link')
      return this.node(
        n.target.startsWith('/') ? n.target : `${path.slice(0, path.lastIndexOf('/'))}/${n.target}`
      );
    return n;
  }

  private statOf(n: Node): SyncFsBridgeStat {
    if (n.type === 'link')
      return { isFile: false, isDirectory: false, isSymbolicLink: true, size: 0 };
    if (n.type === 'dir') return { isFile: false, isDirectory: true, size: 0, mtimeMs: n.mtimeMs };
    return {
      isFile: true,
      isDirectory: false,
      size: n.data.length,
      mtimeMs: n.mtimeMs,
      ino: n.ino,
    };
  }

  readFile(path: string): Uint8Array {
    this.ops.push(`read ${path}`);
    const n = this.node(path);
    if (n.type !== 'file') throw posix('EISDIR');
    return n.data.slice();
  }
  writeFile(path: string, bytes: Uint8Array): void {
    this.ops.push(`write ${path}`);
    const n = this.nodes.get(path);
    this.nodes.set(path, {
      type: 'file',
      data: bytes.slice(),
      mtimeMs: 3000,
      ino: n?.type === 'file' ? n.ino : this.ino++,
    });
  }
  stat(path: string): SyncFsBridgeStat {
    this.ops.push(`stat ${path}`);
    return this.statOf(this.node(path));
  }
  lstat(path: string): SyncFsBridgeStat {
    this.ops.push(`lstat ${path}`);
    return this.statOf(this.node(path, false));
  }
  readdir(path: string): string[] {
    this.ops.push(`readdir ${path}`);
    return this.names(path);
  }
  protected names(path: string): string[] {
    if (this.node(path).type !== 'dir') throw posix('ENOTDIR');
    const prefix = path === '/' ? '/' : `${path}/`;
    return [...this.nodes.keys()]
      .filter((p) => p !== path && p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
      .map((p) => p.slice(prefix.length));
  }
  exists(path: string): boolean {
    return this.nodes.has(path);
  }
  mkdir(path: string): void {
    this.ops.push(`mkdir ${path}`);
    this.dir(path);
  }
  rm(path: string): void {
    this.nodes.delete(path);
  }
  rename(from: string, to: string): void {
    this.ops.push(`rename ${from} ${to}`);
    this.node(from, false);
    for (const [p, n] of [...this.nodes]) {
      if (p !== from && !p.startsWith(`${from}/`)) continue;
      this.nodes.delete(p);
      this.nodes.set(to + p.slice(from.length), n);
    }
  }
  unlink(path: string): void {
    this.node(path, false);
    this.nodes.delete(path);
  }
  rmdir(path: string): void {
    if (this.readdir(path).length > 0) throw posix('ENOTEMPTY');
    this.nodes.delete(path);
  }
  symlink(target: string, linkPath: string): void {
    this.nodes.set(linkPath, { type: 'link', target });
  }
  readlink(path: string): string {
    const n = this.node(path, false);
    if (n.type !== 'link') throw posix('EINVAL');
    return n.target;
  }
  chmod(): void {}
  utimes(path: string, _atimeMs: number, mtimeMs: number): void {
    this.ops.push(`utimes ${path} ${mtimeMs}`);
    const n = this.node(path);
    if (n.type !== 'link') n.mtimeMs = mtimeMs;
  }
}

export class ListingFs extends FakeFs {
  readdirStat(path: string): Array<[string, SyncFsBridgeStat | null]> {
    this.ops.push(`readdir-stat ${path}`);
    const base = path === '/' ? '' : path;
    const n = this.ops.length;
    const out = this.names(path).map((name): [string, SyncFsBridgeStat | null] => [
      name,
      this.lstat(`${base}/${name}`),
    ]);
    this.ops.length = n;
    return out;
  }
}

export class Guest {
  readonly memory: WebAssembly.Memory;
  private top = 1024;

  constructor(shared = false) {
    this.memory = new WebAssembly.Memory({
      initial: 64,
      ...(shared ? { maximum: 64, shared } : {}),
    });
  }

  get view(): DataView {
    return new DataView(this.memory.buffer);
  }

  alloc(n: number): number {
    const at = this.top;
    this.top += (n + 15) & ~15;
    return at;
  }

  str(s: string): [number, number] {
    const b = new TextEncoder().encode(s);
    const at = this.alloc(b.length);
    new Uint8Array(this.memory.buffer, at, b.length).set(b);
    return [at, b.length];
  }

  iov(data: string | number): [number, number, number] {
    const bytes = typeof data === 'number' ? new Uint8Array(data) : new TextEncoder().encode(data);
    const buf = this.alloc(bytes.length);
    new Uint8Array(this.memory.buffer, buf, bytes.length).set(bytes);
    const iov = this.alloc(8);
    this.view.setUint32(iov, buf, true);
    this.view.setUint32(iov + 4, bytes.length, true);
    return [iov, 1, buf];
  }

  read(ptr: number, len: number): string {
    return new TextDecoder().decode(new Uint8Array(this.memory.buffer, ptr, len));
  }

  u32(ptr: number): number {
    return this.view.getUint32(ptr, true);
  }

  u64(ptr: number): bigint {
    return this.view.getBigUint64(ptr, true);
  }
}
