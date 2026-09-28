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
}

export function vfsFile(fs: VfsFileFs, opts: VfsFileOptions): OpenFile {
  const access = opts.flags & O_ACCMODE;
  const readable = access !== O_WRONLY;
  const writable = access === O_WRONLY || access === O_RDWR;

  let data: Uint8Array | undefined =
    opts.contents !== undefined
      ? new Uint8Array(opts.contents)
      : opts.orphan
        ? new Uint8Array(0)
        : undefined;
  let length = data?.length ?? 0;
  let dirty = false;
  let offset = opts.position;

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
        data = new Uint8Array(0);
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
    if (!dirty || !data || opts.orphan) return;
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

    close: () => serial(flush),
  });
}
