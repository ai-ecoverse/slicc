/**
 * `process-children.ts` — `posix_spawn` / `waitpid` inside a wasm-realm
 * process worker (#3530). The runtime publishes this as `Module.sliccKernel`;
 * the toolchain's libc shims (`slicc_spawn.c`) call it when it is there and
 * fall back to `child_process` in the node realm.
 *
 * A child's stdio slot that is one of the program's kernel descriptors is
 * handed to the kernel as is: the child runs concurrently, and `spawn`
 * returns at once. A slot on a file or pipe inside the program's own FS
 * cannot be shared with another worker, so the child's stdin is what that
 * descriptor holds now, and its output is captured and written there once it
 * has exited — `spawn` returns after the child is done, as in the node realm.
 */
import type { SyncSabTransport } from '../realm/sync-sab-bridge.js';
import type { ChildStdio } from './children.js';
import type { ProcessFs, ProcessStream } from './kernel-streams.js';
import type { ForkState, ForkStream } from './protocol.js';
import { wasiErrno } from './wasi-errno.js';

/** What the libc shims call: pids and wait statuses, or a negative WASI errno. */
export interface ProcessKernel {
  spawn(
    file: string,
    argv: string[],
    env: Record<string, string> | null,
    cwd: string | null,
    stdio: number[]
  ): number;
  /** `[pid, status]`; `[0, 0]` for `nohang` with no child exited yet. */
  wait(pid: number, nohang: boolean): [number, number] | number;
  /** fork(2) into a new worker (`slicc-fork.js` supplies the parent's state): the child's pid. */
  fork(state: ForkState): number;
  /** kill(2): 0, or a negative WASI errno (ESRCH, EINVAL). */
  kill(pid: number, sig: number): number;
  /**
   * execve(): wait for the program just spawned as this process's
   * replacement (signals to this process go to it). Its wait status, or a
   * negative WASI errno.
   */
  execWait(pid: number): number;
  /**
   * select(2) on the program's fds: the ready ones, a negative WASI errno
   * (EINTR), or null when some fd is not a kernel descriptor (the caller
   * falls back to Emscripten's own, non-blocking select).
   */
  select(
    read: number[],
    write: number[],
    timeoutMs: number
  ): { read: number[]; write: number[] } | number | null;
}

export interface ProcessKernelDeps {
  transport: SyncSabTransport;
  Fs: ProcessFs;
  /** The environment a child inherits when the caller passes none. */
  env: Record<string, string>;
  /** Push the program's buffered file writes before a child reads the VFS. */
  beforeSpawn(): void;
  /** Drop the program's cached VFS view after a child may have changed it. */
  afterChild(): void;
  /** Hand the open VFS files to the kernel and describe the fd table (process-fork.ts). */
  describeFork(): ForkStream[];
  /** This process's pid: kill() of itself raises the signal in place. */
  pid?: number;
  /** raise(sig) in the program. */
  raise?(sig: number): void;
  /** Whether a waitpid a caught signal interrupted may be retried (SA_RESTART). */
  restartable?(): boolean;
}

/** Whatever the stream holds now (a file, or a pipe its program filled). */
function drain(Fs: ProcessFs, stream: ProcessStream): Uint8Array {
  const chunks: Uint8Array[] = [];
  const buffer = new Uint8Array(65536);
  try {
    for (let n = Fs.read(stream, buffer, 0, buffer.length); n > 0; ) {
      chunks.push(buffer.slice(0, n));
      n = Fs.read(stream, buffer, 0, buffer.length);
    }
  } catch {
    // An empty non-blocking pipe (EAGAIN): nothing more.
  }
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
  /** Children the program has not waited for yet whose status is already here. */
  const reaped = new Map<number, number>();

  const slot = (fd: number, n: number): ChildStdio => {
    const stream = fd >= 0 ? Fs.getStream(fd) : null;
    if (!stream) return { none: true };
    if (stream.sliccKernelFd !== undefined) return { fd: stream.sliccKernelFd };
    return n === 0 ? { input: drain(Fs, stream) } : { capture: true };
  };

  const kernelWait = (pid: number, nohang: boolean): [number, number] | number => {
    let r = transport.call({ op: 'proc-wait', pid, nohang }, Infinity, `proc-wait ${pid}`);
    // Interrupted by a caught signal whose handler asked for SA_RESTART: wait on.
    while (!r.ok && r.errno === 'EINTR' && deps.restartable?.()) {
      r = transport.call({ op: 'proc-wait', pid, nohang }, Infinity, `proc-wait ${pid}`);
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
      // Itself (or its own group, until process groups exist): raise in place.
      if (pid === 0 || pid === deps.pid || pid === -(deps.pid ?? Number.NaN)) {
        if (sig !== 0) deps.raise?.(sig);
        return 0;
      }
      const target = pid < -1 ? -pid : pid;
      const r = transport.call({ op: 'proc-kill', pid: target, sig }, Infinity, `kill ${pid}`);
      return r.ok ? 0 : -wasiErrno(r.errno);
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
