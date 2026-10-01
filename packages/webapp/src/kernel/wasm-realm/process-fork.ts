import type { InheritedSlot } from './children.js';
import type { KernelStreams, ProcessFs, ProcessStream, ProcessSys } from './kernel-streams.js';
import { closesOnExec, O_CLOEXEC, setCloseOnExec } from './process-fds.js';
import type { ForkStream, KernelStreamEntry } from './protocol.js';

const O_RDWR = 0o2;
const O_CREAT = 0o100;
const O_EXCL = 0o200;
const O_TRUNC = 0o1000;

const PLACEHOLDER_DIR = '/dev/slicc-fd';

interface LiveNodeBag {
  live?: { orphan?: boolean; data?: Uint8Array; len?: number };
  mode: number;
}

function isVfsFile(Fs: ProcessFs, stream: ProcessStream): boolean {
  const node = stream.node as LiveNodeBag;
  return node.live !== undefined && Fs.isFile(node.mode);
}

function orphanContents(stream: ProcessStream): Uint8Array | undefined {
  const live = (stream.node as LiveNodeBag).live;
  if (!live?.orphan) return undefined;
  return live.data?.slice(0, live.len ?? live.data.length) ?? new Uint8Array(0);
}

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

function kernelEntry(stream: ProcessStream, kernel: number): ForkStream {
  const cloexec = closesOnExec(stream) ? { cloexec: true } : {};
  if (stream.sliccKernelSocket) {
    return { fd: stream.fd, kernel, kind: 'socket', flags: stream.flags, ...cloexec };
  }
  const kind = stream.sliccKernelFile ? 'file' : stream.tty ? 'tty' : 'stream';
  return { fd: stream.fd, kernel, kind, ...cloexec };
}

export function describeInherited(
  Fs: ProcessFs,
  sys: ProcessSys,
  streams: KernelStreams,
  livePath: (stream: ProcessStream) => string,
  actions: ReadonlyArray<readonly [number, number]> = []
): InheritedSlot[] {
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

const FIFO_MODE = 0o010600;

let nextStreamIno = 0x40000000;

const streamInos = new WeakMap<KernelStreams, Map<string, number>>();

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

        setCloseOnExec(placed, (entry.flags & O_CLOEXEC) !== 0);
      }
    } catch {}
  }
}
