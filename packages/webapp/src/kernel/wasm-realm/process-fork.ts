/**
 * `process-fork.ts` — the descriptor side of fork(2) inside a wasm-realm
 * process worker (#3530).
 *
 * The parent: every VFS file it has open is handed to the kernel as a shared
 * description (`fd-open-vfs`), so parent and child share its offset; then its
 * whole fd table is described for the child ({@link ForkStream}). An
 * unlinked-while-open file (mkstemp) passes its live buffer — the path is
 * gone. The kernel copies the parent's descriptor table, so a kernel-backed
 * fd has the same number in the child.
 *
 * The child: drop the runtime's default streams and rebuild the parent's
 * table — kernel-backed streams on placeholder nodes (a terminal, a pipe, or a
 * regular file for a VFS description, so fstat keeps its type), devices and
 * directories reopened by path.
 */
import type { KernelStreams, ProcessFs, ProcessStream, ProcessSys } from './kernel-streams.js';
import type { ForkStream } from './protocol.js';

const O_RDWR = 0o2;
const O_CREAT = 0o100;
const O_EXCL = 0o200;
const O_TRUNC = 0o1000;
/** Placeholder nodes of the child's kernel-backed streams (module-owned, never on the VFS). */
const PLACEHOLDER_DIR = '/dev/slicc-fd';

/** Live-node state the mount hangs on a regular-file node (`live-vfs-fs.ts`). */
interface LiveNodeBag {
  live?: { orphan?: boolean; data?: Uint8Array; len?: number };
  mode: number;
}

/** A live-VFS regular file: the mount's plugin tags its nodes with `live`. */
function isVfsFile(Fs: ProcessFs, stream: ProcessStream): boolean {
  const node = stream.node as LiveNodeBag;
  return node.live !== undefined && Fs.isFile(node.mode);
}

/**
 * Bytes of an unlinked-while-open file. The path is gone from the VFS; the
 * live node alone still holds them, so the kernel description must take a copy.
 */
function orphanContents(stream: ProcessStream): Uint8Array | undefined {
  const live = (stream.node as LiveNodeBag).live;
  if (!live?.orphan) return undefined;
  return live.data?.slice(0, live.len ?? live.data.length) ?? new Uint8Array(0);
}

/**
 * Hand every open VFS file to the kernel and describe the fd table for the
 * child. Dups of one description (Emscripten's `shared`) stay one description.
 */
export function describeForFork(
  Fs: ProcessFs,
  sys: ProcessSys,
  streams: KernelStreams,
  livePath: (stream: ProcessStream) => string
): ForkStream[] {
  const promoted = new Map<object, number>();
  const out: ForkStream[] = [];
  for (const stream of Fs.streams) {
    if (!stream) continue;
    if (stream.sliccKernelFd === undefined && isVfsFile(Fs, stream)) {
      let kfd = promoted.get(stream.shared);
      if (kfd === undefined) {
        const contents = orphanContents(stream);
        kfd = sys.openVfs(
          livePath(stream),
          stream.flags,
          stream.position,
          contents !== undefined ? { contents, orphan: true } : undefined
        );
        promoted.set(stream.shared, kfd);
      }
      streams.attachFile(stream, kfd);
    }
    if (stream.sliccKernelFd !== undefined) {
      const kind = stream.sliccKernelFile ? 'file' : stream.tty ? 'tty' : 'stream';
      out.push({ fd: stream.fd, kernel: stream.sliccKernelFd, kind });
    } else if (stream.path) {
      out.push({ fd: stream.fd, path: stream.path, flags: stream.flags });
    }
  }
  return out;
}

/** Move `stream` to exactly `fd`. */
function place(Fs: ProcessFs, stream: ProcessStream, fd: number): ProcessStream {
  if (stream.fd === fd) return stream;
  const moved = Fs.dupStream(stream, fd);
  Fs.closeStream(stream.fd);
  return moved;
}

function placeholder(Fs: ProcessFs, entry: { fd: number; kind: string }): ProcessStream {
  if (entry.kind === 'tty') return Fs.open('/dev/tty', O_RDWR);
  if (entry.kind === 'stream') return Fs.open('/dev/null', O_RDWR);
  Fs.mkdirTree(PLACEHOLDER_DIR);
  return Fs.open(`${PLACEHOLDER_DIR}/${entry.fd}`, O_RDWR | O_CREAT);
}

/** Rebuild the parent's fd table in the child. A device that no longer opens stays closed. */
export function restoreForkedStreams(
  Fs: ProcessFs,
  streams: KernelStreams,
  table: readonly ForkStream[]
): void {
  for (const stream of Fs.streams) if (stream) Fs.closeStream(stream.fd);
  for (const entry of table) {
    try {
      if ('kernel' in entry) {
        const stream = place(Fs, placeholder(Fs, entry), entry.fd);
        if (entry.kind === 'file') streams.attachFile(stream, entry.kernel);
        else streams.attach(stream, entry.kernel, entry.kind === 'tty');
      } else {
        place(Fs, Fs.open(entry.path, entry.flags & ~(O_CREAT | O_EXCL | O_TRUNC)), entry.fd);
      }
    } catch {
      /* gone since the fork: the descriptor stays closed */
    }
  }
}
