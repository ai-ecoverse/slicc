import { KernelError, OpenFile } from './fd-table.js';

export interface VfsFileFs {
  readFileBuffer(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: Uint8Array): Promise<void>;
}

const O_ACCMODE = 0o3;
const O_WRONLY = 0o1;
const O_RDWR = 0o2;
const O_APPEND = 0o2000;

const SEEK_SET = 0;
const SEEK_CUR = 1;
const SEEK_END = 2;

export interface VfsFileOptions {
  path: string;

  flags: number;

  position: number;

  contents?: Uint8Array;

  orphan?: boolean;

  truncate?: boolean;

  create?: boolean;
}

export const WRITEBACK_MS = 250;

const WRITEBACK_COST_FACTOR = 10;

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`);
}

export class VfsNode {
  private data: Uint8Array | undefined;
  private length = 0;
  private dirty = false;
  private queue: Promise<unknown> = Promise.resolve();

  private writeBack: ReturnType<typeof setTimeout> | undefined;

  private writeBackCost = 0;

  opens = 0;

  private missing = false;

  constructor(
    private readonly fs: VfsFileFs,
    public path: string,
    contents?: Uint8Array,
    public orphaned = false
  ) {
    if (contents !== undefined) this.data = new Uint8Array(contents);
    else if (orphaned) this.data = new Uint8Array(0);
    this.length = this.data?.length ?? 0;
  }

  serial<T>(op: () => Promise<T>): Promise<T> {
    const next = this.queue.then(op);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async load(): Promise<Uint8Array> {
    if (!this.data) {
      try {
        this.data = await this.fs.readFileBuffer(this.path);
      } catch {
        this.data = new Uint8Array(0);
        this.missing = true;
      }
      this.length = this.data.length;
    }
    return this.data;
  }

  async materialize(): Promise<void> {
    await this.load();
    if (!this.missing || this.orphaned) return;
    this.missing = false;
    await this.fs.writeFile(this.path, this.data?.slice(0, this.length) ?? new Uint8Array(0));
  }

  async size(): Promise<number> {
    await this.load();
    return this.length;
  }

  async pread(max: number, at: number): Promise<Uint8Array> {
    const bytes = await this.load();
    const n = Math.max(0, Math.min(max, this.length - at));
    return bytes.slice(at, at + n);
  }

  async pwrite(bytes: Uint8Array, at: number): Promise<number> {
    await this.load();
    const buf = this.ensure(at + bytes.length);
    if (at > this.length) buf.fill(0, this.length, at);
    buf.set(bytes, at);
    this.length = Math.max(this.length, at + bytes.length);
    this.markDirty();
    return bytes.length;
  }

  async truncate(size: number): Promise<void> {
    await this.load();
    const buf = this.ensure(size);
    if (size > this.length) buf.fill(0, this.length, size);
    this.length = size;
    this.markDirty();
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.writeBack !== undefined || this.orphaned) return;
    const delay = Math.max(WRITEBACK_MS, this.writeBackCost * WRITEBACK_COST_FACTOR);
    this.writeBack = setTimeout(() => {
      this.writeBack = undefined;
      this.serial(() => this.flush()).catch(() => undefined);
    }, delay);
  }

  private ensure(need: number): Uint8Array {
    const cur = this.data ?? new Uint8Array(0);
    if (cur.length >= need) return cur;
    const grown = new Uint8Array(Math.max(need, cur.length * 2, 256));
    grown.set(cur.subarray(0, this.length));
    this.data = grown;
    return grown;
  }

  async flush(): Promise<void> {
    if (!this.dirty || !this.data || this.orphaned) return;
    this.dirty = false;
    const started = performance.now();
    await this.fs.writeFile(this.path, this.data.slice(0, this.length));
    this.writeBackCost = performance.now() - started;
  }
}

export class VfsNodes {
  private readonly byPath = new Map<string, VfsNode>();

  constructor(private readonly fs: VfsFileFs) {}

  open(path: string): VfsNode {
    let node = this.byPath.get(path);
    if (!node) {
      node = new VfsNode(this.fs, path);
      this.byPath.set(path, node);
    }
    node.opens++;
    return node;
  }

  closed(node: VfsNode): void {
    node.opens--;
    if (node.opens === 0 && this.byPath.get(node.path) === node) this.byPath.delete(node.path);
  }

  async flush(path: string): Promise<void> {
    for (const [p, node] of this.byPath) if (within(p, path)) await node.serial(() => node.flush());
  }

  async unlinking(path: string): Promise<void> {
    const node = this.byPath.get(path);
    if (node) await node.serial(() => node.load());
  }

  unlinked(path: string): void {
    const node = this.byPath.get(path);
    if (!node) return;
    node.orphaned = true;
    this.byPath.delete(path);
  }

  renamed(from: string, to: string): void {
    if (from === to) return;
    const moved: VfsNode[] = [];
    for (const [p, node] of this.byPath) {
      if (within(p, from)) moved.push(node);
      else if (within(p, to)) {
        node.orphaned = true;
        this.byPath.delete(p);
      }
    }
    for (const node of moved) {
      this.byPath.delete(node.path);
      node.path = to + node.path.slice(from.length);
      this.byPath.set(node.path, node);
    }
  }
}

export function vfsFile(fs: VfsFileFs, opts: VfsFileOptions, nodes?: VfsNodes): OpenFile {
  const access = opts.flags & O_ACCMODE;
  const readable = access !== O_WRONLY;
  const writable = access === O_WRONLY || access === O_RDWR;
  const node =
    nodes && opts.contents === undefined && !opts.orphan
      ? nodes.open(opts.path)
      : new VfsNode(fs, opts.path, opts.contents, opts.orphan === true);
  if (opts.create) void node.serial(() => node.materialize());
  if (opts.truncate) void node.serial(() => node.truncate(0));
  let offset = opts.position;
  const serial = <T>(op: () => Promise<T>) => node.serial(op);

  return new OpenFile({
    read: readable
      ? (max) =>
          serial(async () => {
            const out = await node.pread(max, offset);
            offset += out.length;
            return out;
          })
      : undefined,
    write: writable
      ? (bytes) =>
          serial(async () => {
            if (opts.flags & O_APPEND) offset = await node.size();
            offset += await node.pwrite(bytes, offset);
            return bytes.length;
          })
      : undefined,
    seek: (to, whence) =>
      serial(async () => {
        let base = 0;
        if (whence === SEEK_CUR) base = offset;
        else if (whence === SEEK_END) base = await node.size();
        else if (whence !== SEEK_SET) throw new KernelError('EINVAL');
        if (base + to < 0) throw new KernelError('EINVAL');
        offset = base + to;
        return offset;
      }),
    pread: (max, at) =>
      serial(() => {
        if (!readable) throw new KernelError('EBADF');
        return node.pread(max, at);
      }),
    pwrite: (bytes, at) =>
      serial(() => {
        if (!writable) throw new KernelError('EBADF');
        return node.pwrite(bytes, at);
      }),
    resize: (size) =>
      serial(() => {
        if (!writable) throw new KernelError('EBADF');
        return node.truncate(size);
      }),
    stat: () =>
      serial(async () => ({
        path: node.path,
        size: await node.size(),
        ...(node.orphaned ? { orphan: true as const } : {}),
      })),
    flush: () => serial(() => node.flush()),

    close: () =>
      serial(async () => {
        await node.flush();
        nodes?.closed(node);
      }),
  });
}
