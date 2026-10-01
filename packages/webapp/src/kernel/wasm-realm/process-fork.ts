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
 * directories reopened by path. FD_CLOEXEC goes along.
 *
 * posix_spawn / execve hand a child the same kind of kernel descriptors: every
 * fd beyond 0-2 that is not close-on-exec ({@link describeInherited}), which
 * the child opens at the same numbers ({@link placeKernelStream}).
 */
import type { InheritedSlot } from './children.js';
import type { KernelStreams, ProcessFs, ProcessStream, ProcessSys } from './kernel-streams.js';
import { closesOnExec, O_CLOEXEC, setCloseOnExec } from './process-fds.js';
import type { ForkStream, KernelStreamEntry } from './protocol.js';

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
 * Hands the program's open VFS files to the kernel as shared descriptions,
 * one per Emscripten description (`shared`): dups stay one description. A
 * fork's whole table, a spawn's inherited fds, and a spawn's stdio (a shell's
 * redirect) each take one.
 */
export function vfsPromoter(
  Fs: ProcessFs,
  sys: ProcessSys,
  streams: KernelStreams,
  livePath: (stream: ProcessStream) => string
): (stream: ProcessStream) => void {
  const promoted = new Map<object, number>();
  return (stream) => {
    if (stream.sliccKernelFd !== undefined || !isVfsFile(Fs, stream)) return;
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
  };
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
  const promote = vfsPromoter(Fs, sys, streams, livePath);
  const out: ForkStream[] = [];
  for (const stream of Fs.streams) {
    if (!stream) continue;
    promote(stream);
    if (stream.sliccKernelFd !== undefined) {
      out.push(kernelEntry(stream, stream.sliccKernelFd));
    } else if (stream.path) {
      const flags = stream.flags | (closesOnExec(stream) ? O_CLOEXEC : 0);
      out.push({ fd: stream.fd, path: stream.path, flags });
    }
  }
  return out;
}

/** A kernel-backed stream as the child rebuilds it (a socket keeps its O_NONBLOCK). */
function kernelEntry(stream: ProcessStream, kernel: number): ForkStream {
  const cloexec = closesOnExec(stream) ? { cloexec: true } : {};
  if (stream.sliccKernelSocket) {
    return { fd: stream.fd, kernel, kind: 'socket', flags: stream.flags, ...cloexec };
  }
  const kind = stream.sliccKernelFile ? 'file' : stream.tty ? 'tty' : 'stream';
  return { fd: stream.fd, kernel, kind, ...cloexec };
}

/**
 * The fds beyond 0-2 a child the program spawns or execs inherits, at the
 * same numbers: each one not close-on-exec, then `actions` (posix_spawn's
 * file actions on fds beyond 2: `[target, source]`, source -1 closes). A VFS
 * file is handed to the kernel first; a device or a file of the program's own
 * memory FS has no kernel descriptor and stays behind.
 */
export function describeInherited(
  Fs: ProcessFs,
  sys: ProcessSys,
  streams: KernelStreams,
  livePath: (stream: ProcessStream) => string,
  actions: ReadonlyArray<readonly [number, number]> = []
): InheritedSlot[] {
  // The child's table as the actions leave it, in order (a later action may
  // name an earlier one's target); FD_CLOEXEC applies after them, at exec.
  const table = new Map<number, { stream: ProcessStream; cloexec: boolean }>();
  for (const stream of Fs.streams) {
    if (stream) table.set(stream.fd, { stream, cloexec: closesOnExec(stream) });
  }
  for (const [target, source] of actions) {
    if (target <= 2) continue;
    const from = source >= 0 ? table.get(source) : undefined;
    if (from) table.set(target, { stream: from.stream, cloexec: false });
    else table.delete(target);
  }
  const slots = new Map<number, ProcessStream>();
  for (const [fd, { stream, cloexec }] of table) {
    if (fd > 2 && !cloexec) slots.set(fd, stream);
  }
  const promote = vfsPromoter(Fs, sys, streams, livePath);
  const out: InheritedSlot[] = [];
  for (const [fd, stream] of slots) {
    promote(stream);
    if (stream.sliccKernelFd === undefined) continue;
    const flags = stream.sliccKernelSocket ? { flags: stream.flags } : {};
    out.push({ fd, kernel: stream.sliccKernelFd, ...flags });
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

function placeholder(
  Fs: ProcessFs,
  streams: KernelStreams,
  entry: { fd: number; kind: string; flags?: number }
): ProcessStream {
  if (entry.kind === 'socket') return streams.socketStream(entry.flags ?? O_RDWR);
  if (entry.kind === 'tty') return Fs.open('/dev/tty', O_RDWR);
  if (entry.kind === 'stream') return Fs.open('/dev/null', O_RDWR);
  Fs.mkdirTree(PLACEHOLDER_DIR);
  return Fs.open(`${PLACEHOLDER_DIR}/${entry.fd}`, O_RDWR | O_CREAT);
}

/** st_mode of a FIFO (S_IFIFO | 0600). */
const FIFO_MODE = 0o010600;
/** Inode numbers of stream placeholders: one per description, clear of the FS's own. */
let nextStreamIno = 0x40000000;
/** Per process (its KernelStreams): the inode of each description placed so far. */
const streamInos = new WeakMap<KernelStreams, Map<string, number>>();

/**
 * fstat of a stream placeholder: a FIFO of its own. Every one sits on
 * `/dev/null`, and two operands that stat as the same node are one file to
 * `diff <(a) <(b)`, which then compares nothing. Aliases of one description
 * (`identity`: the kernel's description id, else the kernel fd a fork kept)
 * share an inode, as dups do.
 */
function asFifo(stream: ProcessStream, streams: KernelStreams, identity: string): void {
  let inos = streamInos.get(streams);
  if (!inos) streamInos.set(streams, (inos = new Map()));
  let ino = inos.get(identity);
  if (ino === undefined) inos.set(identity, (ino = nextStreamIno++));
  const node = stream.node;
  const fixed = ino;
  stream.stream_ops = {
    ...stream.stream_ops,
    getattr: () => ({ ...node.node_ops?.getattr?.(node), mode: FIFO_MODE, ino: fixed, size: 0 }),
  };
}

/** Open program fd `entry.fd` on kernel descriptor `entry.kernel`, backed as `entry.kind` says. */
export function placeKernelStream(
  Fs: ProcessFs,
  streams: KernelStreams,
  entry: KernelStreamEntry
): ProcessStream {
  const stream = place(Fs, placeholder(Fs, streams, entry), entry.fd);
  if (entry.kind === 'file') streams.attachFile(stream, entry.kernel);
  else if (entry.kind === 'socket') streams.attachSocket(stream, entry.kernel);
  else streams.attach(stream, entry.kernel, entry.kind === 'tty');
  if (entry.kind === 'tty') streams.nameTerminal(stream);
  if (entry.kind === 'stream') {
    asFifo(stream, streams, entry.desc !== undefined ? `d${entry.desc}` : `k${entry.kernel}`);
  }
  setCloseOnExec(stream, entry.cloexec === true);
  return stream;
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
        placeKernelStream(Fs, streams, entry);
      } else {
        const placed = place(
          Fs,
          Fs.open(entry.path, entry.flags & ~(O_CREAT | O_EXCL | O_TRUNC)),
          entry.fd
        );
        // A move is a dup, which starts without FD_CLOEXEC: set it again.
        setCloseOnExec(placed, (entry.flags & O_CLOEXEC) !== 0);
      }
    } catch {
      /* gone since the fork: the descriptor stays closed */
    }
  }
}
