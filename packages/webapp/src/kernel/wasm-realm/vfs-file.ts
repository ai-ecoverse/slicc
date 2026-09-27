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
 * reference closes (or on a flush), like the live mount does per worker.
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
}

export function vfsFile(fs: VfsFileFs, opts: VfsFileOptions): OpenFile {
  const access = opts.flags & O_ACCMODE;
  const readable = access !== O_WRONLY;
  const writable = access === O_WRONLY || access === O_RDWR;
  let data: Uint8Array | undefined;
  let length = 0;
  let dirty = false;
  let offset = opts.position;
  // One operation at a time: a read and a write from two processes interleave
  // at operation granularity, never inside one.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(op: () => Promise<T>): Promise<T> => {
    const next = queue.then(op);
    queue = next.catch(() => undefined);
    return next;
  };

  const load = async (): Promise<Uint8Array> => {
    if (!data) {
      try {
        data = await fs.readFileBuffer(opts.path);
      } catch {
        data = new Uint8Array(0); // created, or gone since: start empty
      }
      length = data.length;
    }
    return data;
  };

  const ensure = (need: number): Uint8Array => {
    const cur = data ?? new Uint8Array(0);
    if (cur.length >= need) return cur;
    const grown = new Uint8Array(Math.max(need, cur.length * 2, 256));
    grown.set(cur.subarray(0, length));
    data = grown;
    return grown;
  };

  const flush = async (): Promise<void> => {
    if (!dirty || !data) return;
    dirty = false;
    await fs.writeFile(opts.path, data.slice(0, length));
  };

  return new OpenFile({
    read: readable
      ? (max) =>
          serial(async () => {
            const bytes = await load();
            const n = Math.max(0, Math.min(max, length - offset));
            const out = bytes.slice(offset, offset + n);
            offset += n;
            return out;
          })
      : undefined,
    write: writable
      ? (bytes) =>
          serial(async () => {
            await load();
            if (opts.flags & O_APPEND) offset = length;
            const buf = ensure(offset + bytes.length);
            if (offset > length) buf.fill(0, length, offset);
            buf.set(bytes, offset);
            offset += bytes.length;
            length = Math.max(length, offset);
            dirty = true;
            return bytes.length;
          })
      : undefined,
    seek: (to, whence) =>
      serial(async () => {
        let base = 0;
        if (whence === SEEK_CUR) base = offset;
        else if (whence === SEEK_END) {
          await load();
          base = length;
        } else if (whence !== SEEK_SET) throw new KernelError('EINVAL');
        if (base + to < 0) throw new KernelError('EINVAL');
        offset = base + to;
        return offset;
      }),
    flush: () => serial(flush),
    close: () => {
      void serial(flush);
    },
  });
}
