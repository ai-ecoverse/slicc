import type { KernelStreams, ProcessFs, ProcessStream, ProcessSys } from './kernel-streams.js';
import type { ForkStream } from './protocol.js';

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
      out.push(kernelEntry(stream, stream.sliccKernelFd));
    } else if (stream.path) {
      out.push({ fd: stream.fd, path: stream.path, flags: stream.flags });
    }
  }
  return out;
}

function kernelEntry(stream: ProcessStream, kernel: number): ForkStream {
  if (stream.sliccKernelSocket)
    return { fd: stream.fd, kernel, kind: 'socket', flags: stream.flags };
  const kind = stream.sliccKernelFile ? 'file' : stream.tty ? 'tty' : 'stream';
  return { fd: stream.fd, kernel, kind };
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

export function restoreForkedStreams(
  Fs: ProcessFs,
  streams: KernelStreams,
  table: readonly ForkStream[]
): void {
  for (const stream of Fs.streams) if (stream) Fs.closeStream(stream.fd);
  for (const entry of table) {
    try {
      if ('kernel' in entry) {
        const stream = place(Fs, placeholder(Fs, streams, entry), entry.fd);
        if (entry.kind === 'file') streams.attachFile(stream, entry.kernel);
        else if (entry.kind === 'socket') streams.attachSocket(stream, entry.kernel);
        else streams.attach(stream, entry.kernel, entry.kind === 'tty');
      } else {
        place(Fs, Fs.open(entry.path, entry.flags & ~(O_CREAT | O_EXCL | O_TRUNC)), entry.fd);
      }
    } catch {}
  }
}
