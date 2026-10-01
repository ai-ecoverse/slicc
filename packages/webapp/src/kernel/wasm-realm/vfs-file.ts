/**
 * `vfs-file.ts` — a VFS file as a kernel open file description (#3530).
 *
 * A program's own opens of VFS files stay inside its worker (the live VFS
 * mount), which is fast but private. When a process forks, the files it has
 * open are handed to the kernel as these descriptions, so parent and child
 * share one offset and one buffer, as dup'd descriptors do on Unix: bash's
 * `{ a; b; } > out` appends b after a, and a script bash reads is read on
 * from where its parent stopped.
 *
 * The content is loaded on first use and written back when the last
 * reference closes (or on a flush), like the live mount does per worker —
 * and, while writes keep coming, shortly after them ({@link WRITEBACK_MS}):
 * another process reads the path, not this buffer, so a long-running
 * program's redirected output (`job > log &`) shows up as it runs.
 * An unlinked-while-open file (mkstemp) carries its live bytes across the
 * handoff and is never written back — the path is gone.
 *
 * A process's descriptions of one path share one `VfsNode` (`VfsNodes`), as
 * a WASI worker's buffered opens share one buffer: a threaded WASI program
 * opens every file here, so two opens see each other's writes, and an
 * unlink or rename reaches the bytes of every open.
 */
import { KernelError, OpenFile } from './fd-table.js';

/** The filesystem slice a description reads and writes through (the spawner's gated fs). */
export interface VfsFileFs {
  readFileBuffer(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: Uint8Array): Promise<void>;
}

/** musl's open(2) flag bits the description honors. */
const O_ACCMODE = 0o3;
const O_WRONLY = 0o1;
const O_RDWR = 0o2;
const O_APPEND = 0o2000;

const SEEK_SET = 0;
const SEEK_CUR = 1;
const SEEK_END = 2;

export interface VfsFileOptions {
  path: string;
  /** open(2) flags of the descriptor it replaces. */
  flags: number;
  /** Its offset when it was handed over. */
  position: number;
  /**
   * Bytes already in the live node (an unlinked-while-open file). When set,
   * the description never re-reads the path — it is gone from the VFS.
   */
  contents?: Uint8Array;
  /** Unlinked while open: never write back (the live mount's orphan rule). */
  orphan?: boolean;
  /** Created or truncated by the open: empty, whatever the path held. */
  truncate?: boolean;
  /**
   * O_CREAT: the file is made at the open when the path is missing, as on
   * Linux, and left as it is when it exists (only `truncate` empties it).
   */
  create?: boolean;
}

/** How soon a written node writes itself back, at the least. */
export const WRITEBACK_MS = 250;
/**
 * A write-back rewrites the whole file: the next waits this many times as
 * long as the last took, so a large file costs at most a tenth of the time.
 */
const WRITEBACK_COST_FACTOR = 10;

/** Whether `path` is `root` or beneath it. */
function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`);
}

/**
 * One VFS file's bytes as a process holds them: loaded on first use, written
 * back on a flush, never written back once orphaned (its path is gone).
 * Operations run one at a time: a read and a write interleave at operation
 * granularity, never inside one.
 */
export class VfsNode {
  private data: Uint8Array | undefined;
  private length = 0;
  private dirty = false;
  private queue: Promise<unknown> = Promise.resolve();
  /** The write-back scheduled after a write, if any. */
  private writeBack: ReturnType<typeof setTimeout> | undefined;
  /** How long the last write-back took (ms). */
  private writeBackCost = 0;
  /** Descriptions on it. */
  opens = 0;
  /** The path held no file when it was first read (what `materialize` makes). */
  private missing = false;

  constructor(
    private readonly fs: VfsFileFs,
    public path: string,
    contents?: Uint8Array,
    public orphaned = false
  ) {
    // Orphans carry their live bytes (possibly empty); never re-read a gone path.
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
        this.data = new Uint8Array(0); // created, or gone since: start empty
        this.missing = true;
      }
      this.length = this.data.length;
    }
    return this.data;
  }

  /** Put the file on the VFS now if the path is missing (O_CREAT); never touch one that exists. */
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

  /** Written: write back soon, once — later writes ride along. */
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

/**
 * The nodes of a process's open VFS files, by path: what an unlink or a
 * rename (the program's own, over the sync-fs bridge) does to them.
 */
export class VfsNodes {
  private readonly byPath = new Map<string, VfsNode>();

  constructor(private readonly fs: VfsFileFs) {}

  /** The node of `path`, shared with the process's other opens of it. */
  open(path: string): VfsNode {
    let node = this.byPath.get(path);
    if (!node) {
      node = new VfsNode(this.fs, path);
      this.byPath.set(path, node);
    }
    node.opens++;
    return node;
  }

  /** A description on `node` closed: the last one forgets it. */
  closed(node: VfsNode): void {
    node.opens--;
    if (node.opens === 0 && this.byPath.get(node.path) === node) this.byPath.delete(node.path);
  }

  /** Write back what is open at or beneath `path` (a stat of it follows). */
  async flush(path: string): Promise<void> {
    for (const [p, node] of this.byPath) if (within(p, path)) await node.serial(() => node.flush());
  }

  /** `path` is about to be unlinked: load its bytes, so its opens keep them. */
  async unlinking(path: string): Promise<void> {
    const node = this.byPath.get(path);
    if (node) await node.serial(() => node.load());
  }

  /** `path` was unlinked: its opens keep their bytes and never write them back. */
  unlinked(path: string): void {
    const node = this.byPath.get(path);
    if (!node) return;
    node.orphaned = true;
    this.byPath.delete(path);
  }

  /** `from` became `to`: what was open at `to` is replaced; what was open at `from` follows. */
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

/**
 * A description of a VFS file: its own offset and access mode on a node —
 * the process's shared node of the path (`nodes`), or a private one (handed
 * over `contents`, an orphan, or no registry).
 */
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
    // Awaitable: process exit and fd-close wait for the final writeback.
    close: () =>
      serial(async () => {
        await node.flush();
        nodes?.closed(node);
      }),
  });
}
