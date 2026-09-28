import type { SyncFsResult } from '../realm/sync-fs-wire.js';
import { type FdTable, KernelError, OpenFile, pollFile } from './fd-table.js';
import { KernelSocket, type LoopbackNet, type SockAddr, type SocketDomain } from './socket.js';

export type SocketSyscall =
  | { op: 'sock-open'; domain: SocketDomain }
  | { op: 'sock-pair'; domain: SocketDomain }
  | { op: 'sock-bind'; fd: number; addr: SockAddr }
  | { op: 'sock-listen'; fd: number; backlog: number }
  | { op: 'sock-accept'; fd: number; nonblock: boolean }
  | { op: 'sock-connect'; fd: number; addr: SockAddr; nonblock: boolean }
  | { op: 'sock-shutdown'; fd: number; how: number }
  | { op: 'sock-name'; fd: number; peer: boolean }
  | { op: 'sock-getopt'; fd: number; level: number; name: number }
  | { op: 'sock-setopt'; fd: number; level: number; name: number; value: number };

export const SOCKET_OPS: readonly SocketSyscall['op'][] = [
  'sock-open',
  'sock-pair',
  'sock-bind',
  'sock-listen',
  'sock-accept',
  'sock-connect',
  'sock-shutdown',
  'sock-name',
  'sock-getopt',
  'sock-setopt',
];

export interface SocketProcess {
  fds: FdTable;
  net: LoopbackNet;

  blocking(): AbortSignal;
}

function socketAt(fds: FdTable, fd: number): KernelSocket {
  const file = fds.get(fd).file;
  if (!(file instanceof KernelSocket)) throw new KernelError('ENOTSOCK');
  return file;
}

const ok = (json?: unknown): SyncFsResult =>
  json === undefined ? { ok: true, kind: 'void' } : { ok: true, kind: 'json', json };

export async function socketSyscall(
  req: SocketSyscall,
  proc: SocketProcess
): Promise<SyncFsResult> {
  const { fds, net } = proc;
  switch (req.op) {
    case 'sock-open':
      return ok(fds.install(new OpenFile(net.socket(req.domain)), 3));
    case 'sock-pair': {
      const [a, b] = KernelSocket.pair(net, req.domain);
      const first = fds.install(new OpenFile(a), 3);
      try {
        return ok([first, fds.install(new OpenFile(b), 3)]);
      } catch (e) {
        await Promise.resolve(fds.close(first));
        throw e;
      }
    }
    case 'sock-bind':
      socketAt(fds, req.fd).bind(req.addr);
      return ok();
    case 'sock-listen':
      socketAt(fds, req.fd).listen(req.backlog);
      return ok();
    case 'sock-accept':
      return ok(await accept(proc, req.fd, req.nonblock));
    case 'sock-connect':
      socketAt(fds, req.fd).connect(req.addr);

      if (req.nonblock) throw new KernelError('EINPROGRESS');
      return ok();
    case 'sock-shutdown':
      socketAt(fds, req.fd).shutdown(req.how);
      return ok();
    case 'sock-name': {
      const socket = socketAt(fds, req.fd);
      const addr = req.peer ? socket.peer : socket.local;
      if (req.peer && !addr) throw new KernelError('ENOTCONN');
      return ok(addr ?? unnamed(socket.domain));
    }
    case 'sock-getopt':
      return ok(socketAt(fds, req.fd).getOption(req.level, req.name));
    case 'sock-setopt':
      socketAt(fds, req.fd).setOption(req.level, req.name, req.value);
      return ok();
  }
}

function unnamed(domain: SocketDomain): SockAddr {
  return domain === 'inet'
    ? { family: 'inet', host: '0.0.0.0', port: 0 }
    : { family: 'unix', path: '' };
}

async function accept(
  proc: SocketProcess,
  fd: number,
  nonblock: boolean
): Promise<{ fd: number; peer: SockAddr | undefined }> {
  const listener = socketAt(proc.fds, fd);

  const waits = !nonblock && !pollFile(listener).readable;
  const socket = await listener.accept(waits ? proc.blocking() : undefined, nonblock);
  return { fd: proc.fds.install(new OpenFile(socket), 3), peer: socket.peer };
}
