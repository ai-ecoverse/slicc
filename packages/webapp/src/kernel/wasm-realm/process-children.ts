import type { SyncSabTransport } from '../realm/sync-sab-bridge.js';
import type { ChildStdio } from './children.js';
import type { ProcessFs, ProcessStream } from './process-runtime.js';
import { wasiErrno } from './wasi-errno.js';

export interface ProcessKernel {
  spawn(
    file: string,
    argv: string[],
    env: Record<string, string> | null,
    cwd: string | null,
    stdio: number[]
  ): number;

  wait(pid: number, nohang: boolean): [number, number] | number;
}

export interface ProcessKernelDeps {
  transport: SyncSabTransport;
  Fs: ProcessFs;

  env: Record<string, string>;

  beforeSpawn(): void;

  afterChild(): void;
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

  const slot = (fd: number, n: number): ChildStdio => {
    const stream = fd >= 0 ? Fs.getStream(fd) : null;
    if (!stream) return { none: true };
    if (stream.sliccKernelFd !== undefined) return { fd: stream.sliccKernelFd };
    return n === 0 ? { input: drain(Fs, stream) } : { capture: true };
  };

  const kernelWait = (pid: number, nohang: boolean): [number, number] | number => {
    const r = transport.call({ op: 'proc-wait', pid, nohang }, Infinity, `proc-wait ${pid}`);
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
    spawn(file, argv, env, cwd, fds) {
      const stdio = [0, 1, 2].map((n) => slot(fds[n] ?? -1, n));
      deps.beforeSpawn();
      const r = transport.call(
        { op: 'proc-spawn', file, argv, env: env ?? deps.env, cwd: cwd ?? Fs.cwd(), stdio },
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
    wait(pid, nohang) {
      const key = pid > 0 ? (reaped.has(pid) ? pid : undefined) : reaped.keys().next().value;
      if (key !== undefined) {
        const status = reaped.get(key) as number;
        reaped.delete(key);
        return [key, status];
      }
      return kernelWait(pid, nohang);
    },
  };
}
