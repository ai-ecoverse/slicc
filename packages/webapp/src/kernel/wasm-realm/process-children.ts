import type { SyncFsResult } from '../realm/sync-fs-wire.js';
import type { SyncSabTransport } from '../realm/sync-sab-bridge.js';
import type { ChildStdio, InheritedSlot } from './children.js';
import type { ProcessFs, ProcessStream } from './kernel-streams.js';
import type { WasmSyscall } from './process.js';
import type { SocketKernel } from './process-sockets.js';
import type { ForkState, ForkStream } from './protocol.js';
import { wasiErrno } from './wasi-errno.js';

const WUNTRACED = 2;
const WCONTINUED = 8;

function status(r: SyncFsResult): number {
  return r.ok ? 0 : -wasiErrno(r.errno);
}

function number(r: SyncFsResult): number {
  if (!r.ok) return -wasiErrno(r.errno);
  return r.kind === 'json' && typeof r.json === 'number' ? r.json : -wasiErrno('EIO');
}

export interface ProcessKernel {
  spawn(
    file: string,
    argv: string[],
    env: Record<string, string> | null,
    cwd: string | null,
    stdio: number[],
    actions?: ReadonlyArray<readonly [number, number]>
  ): number;

  wait(pid: number, nohang: boolean, options?: number): [number, number] | number;

  fork(state: ForkState): number;

  kill(pid: number, sig: number): number;

  setpgid(pid: number, pgid: number): number;
  setsid(): number;

  getpgid(pid: number): number;
  getsid(pid: number): number;

  tcgetpgrp(fd: number): number;

  tcsetpgrp(fd: number, pgrp: number): number;

  execWait(pid: number): number;

  select(
    read: number[],
    write: number[],
    timeoutMs: number
  ): { read: number[]; write: number[] } | number | null;

  net?: SocketKernel;
}

export interface ProcessKernelDeps {
  transport: SyncSabTransport;
  Fs: ProcessFs;

  env: Record<string, string>;

  beforeSpawn(): void;

  afterChild(): void;

  describeFork(): ForkStream[];

  inherit?(actions?: ReadonlyArray<readonly [number, number]>): InheritedSlot[];

  pid?: number;

  raise?(sig: number): void;

  restartable?(): boolean;
}

function drain(Fs: ProcessFs, stream: ProcessStream): Uint8Array {
  const chunks: Uint8Array[] = [];
  const buffer = new Uint8Array(65536);
  try {
    for (let n = Fs.read(stream, buffer, 0, buffer.length); n > 0; ) {
      chunks.push(buffer.slice(0, n));
      n = Fs.read(stream, buffer, 0, buffer.length);
    }
  } catch {}
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export function createProcessKernel(deps: ProcessKernelDeps): ProcessKernel {
  const { transport, Fs } = deps;

  const reaped = new Map<number, number>();

  const call = (req: WasmSyscall, label: string): SyncFsResult =>
    transport.call(req, Infinity, label);

  const slot = (fd: number, n: number): ChildStdio => {
    const stream = fd >= 0 ? Fs.getStream(fd) : null;
    if (!stream) return { none: true };
    if (stream.sliccKernelFd !== undefined) return { fd: stream.sliccKernelFd };
    return n === 0 ? { input: drain(Fs, stream) } : { capture: true };
  };

  const kernelWait = (pid: number, nohang: boolean, options = 0): [number, number] | number => {
    const req = {
      op: 'proc-wait' as const,
      pid,
      nohang,
      ...(options & WUNTRACED ? { untraced: true } : {}),
      ...(options & WCONTINUED ? { continued: true } : {}),
    };
    let r = transport.call(req, Infinity, `proc-wait ${pid}`);

    while (!r.ok && r.errno === 'EINTR' && deps.restartable?.()) {
      r = transport.call(req, Infinity, `proc-wait ${pid}`);
    }
    if (!r.ok) return -wasiErrno(r.errno);
    const waited = r.kind === 'json' ? (r.json as [number, number]) : [0, 0];
    if (waited[0] > 0) deps.afterChild();
    return [waited[0], waited[1]];
  };

  const deliver = (pid: number, n: number, fd: number): void => {
    const r = transport.call(
      { op: 'proc-captured', pid, slot: n },
      Infinity,
      `proc-captured ${pid}`
    );
    const stream = Fs.getStream(fd);
    if (r.ok && r.kind === 'bytes' && r.bytes.length > 0 && stream) {
      Fs.write(stream, r.bytes, 0, r.bytes.length);
    }
  };

  return {
    spawn(file, argv, env, cwd, fds, actions) {
      const stdio = [0, 1, 2].map((n) => slot(fds[n] ?? -1, n));
      deps.beforeSpawn();
      const inherit = deps.inherit?.(actions) ?? [];
      const r = transport.call(
        {
          op: 'proc-spawn',
          file,
          argv,
          env: env ?? deps.env,
          cwd: cwd ?? Fs.cwd(),
          stdio,
          ...(inherit.length > 0 ? { inherit } : {}),
        },
        Infinity,
        `proc-spawn ${file}`
      );
      if (!r.ok) return -wasiErrno(r.errno);
      const pid = r.kind === 'json' ? (r.json as number) : 0;
      const captures = [1, 2].filter((n) => 'capture' in (stdio[n] as ChildStdio));
      if (captures.length === 0) return pid;
      const waited = kernelWait(pid, false);
      if (typeof waited === 'number') return waited;
      for (const n of captures) deliver(pid, n, fds[n] as number);
      reaped.set(pid, waited[1]);
      return pid;
    },
    fork(state) {
      deps.beforeSpawn();
      const streams = deps.describeFork();
      const r = transport.call(
        { op: 'proc-fork', state: { ...state, streams, cwd: Fs.cwd() } },
        Infinity,
        'proc-fork'
      );
      if (!r.ok) return -wasiErrno(r.errno);
      return r.kind === 'json' ? (r.json as number) : -wasiErrno('EIO');
    },
    select(read, write, timeoutMs) {
      const kernel = (fd: number) => Fs.getStream(fd)?.sliccKernelFd;
      const kr = read.map(kernel);
      const kw = write.map(kernel);
      if ([...kr, ...kw].some((k) => k === undefined)) return null;
      const r = transport.call(
        { op: 'fd-select', read: kr as number[], write: kw as number[], timeoutMs },
        Infinity,
        'select'
      );
      if (!r.ok) return -wasiErrno(r.errno);
      const got = (r.kind === 'json' ? r.json : { read: [], write: [] }) as {
        read: number[];
        write: number[];
      };
      return {
        read: read.filter((_, i) => got.read.includes(kr[i] as number)),
        write: write.filter((_, i) => got.write.includes(kw[i] as number)),
      };
    },
    execWait(pid) {
      const r = transport.call({ op: 'proc-exec', pid }, Infinity, `exec ${pid}`);
      if (!r.ok) return -wasiErrno(r.errno);
      deps.afterChild();
      return r.kind === 'json' ? (r.json as [number, number])[1] : 0;
    },
    kill(pid, sig) {
      if (pid === deps.pid) {
        if (sig !== 0) deps.raise?.(sig);
        return 0;
      }
      return status(call({ op: 'proc-kill', pid, sig }, `kill ${pid}`));
    },
    setpgid: (pid, pgid) => status(call({ op: 'proc-setpgid', pid, pgid }, 'setpgid')),
    setsid: () => number(call({ op: 'proc-setsid' }, 'setsid')),
    getpgid: (pid) => number(call({ op: 'proc-getpgid', pid }, 'getpgid')),
    getsid: (pid) => number(call({ op: 'proc-getsid', pid }, 'getsid')),
    tcgetpgrp(fd) {
      const kfd = Fs.getStream(fd)?.sliccKernelFd;
      if (kfd === undefined) return -wasiErrno('ENOTTY');
      return number(call({ op: 'tty-pgrp-get', fd: kfd }, 'tcgetpgrp'));
    },
    tcsetpgrp(fd, pgrp) {
      const kfd = Fs.getStream(fd)?.sliccKernelFd;
      if (kfd === undefined) return -wasiErrno('ENOTTY');
      return status(call({ op: 'tty-pgrp-set', fd: kfd, pgrp }, 'tcsetpgrp'));
    },
    wait(pid, nohang, options) {
      const key = pid > 0 ? (reaped.has(pid) ? pid : undefined) : reaped.keys().next().value;
      if (key !== undefined) {
        const status = reaped.get(key) as number;
        reaped.delete(key);
        return [key, status];
      }
      return kernelWait(pid, nohang, options);
    },
  };
}
