/**
 * `process.ts` — a wasm-realm process as the kernel sees it (#3530): its pid
 * and fd table, and the syscalls its worker sends over the SAB bridge.
 *
 * Results use the sync bridge's {@link SyncFsResult} shape, so the existing
 * Atomics/SAB transport and responder carry them unchanged: a read is
 * `bytes` (empty at end of file), a write is `json` (the byte count), a close
 * is `void`, a failure is an errno. A read on an empty pipe resolves only
 * when data arrives: the responder answers late, the worker stays parked in
 * `Atomics.wait`, and nothing blocks the kernel. `proc-spawn` / `proc-wait`
 * start and reap children (`children.ts`); a wait parks the worker the same way.
 */
import type { SyncFsResult } from '../realm/sync-fs-wire.js';
import {
  type ChildForker,
  type ChildSpawner,
  type ChildStdio,
  ChildTable,
  SpawnError,
} from './children.js';
import { type FdTable, KernelError, openPipe, pollFile } from './fd-table.js';
import type { ForkState } from './protocol.js';
import { selectFds } from './select.js';
import { type DefaultAction, defaultAction, isSignal, SIG, sigbit } from './signals.js';
import { type VfsFileFs, vfsFile } from './vfs-file.js';

/** The syscalls of a wasm-realm process (the request bodies on the SAB wire). */
export type WasmSyscall =
  | { op: 'fd-read'; fd: number; max: number }
  | { op: 'fd-write'; fd: number; body: Uint8Array }
  | { op: 'fd-close'; fd: number }
  | { op: 'fd-pipe' }
  | { op: 'fd-poll'; fd: number }
  | {
      op: 'fd-open-vfs';
      path: string;
      flags: number;
      position: number;
      /** Live bytes of an unlinked-while-open file (mkstemp). */
      contents?: Uint8Array;
      /** Never write back: the path is gone from the VFS. */
      orphan?: boolean;
    }
  | { op: 'fd-seek'; fd: number; offset: number; whence: number }
  | { op: 'fd-select'; read: number[]; write: number[]; timeoutMs: number }
  | { op: 'fd-flush'; fd: number }
  | {
      op: 'proc-spawn';
      file: string;
      argv: string[];
      env: Record<string, string>;
      cwd: string;
      stdio: ChildStdio[];
    }
  | { op: 'proc-wait'; pid: number; nohang: boolean }
  | { op: 'proc-captured'; pid: number; slot: number }
  | { op: 'proc-fork'; state: ForkState }
  | { op: 'proc-kill'; pid: number; sig: number }
  | { op: 'proc-exec'; pid: number }
  | { op: 'sig-mask'; caught: number; ignored: number };

/** The syscalls on a descriptor. */
type FdSyscall = Extract<WasmSyscall, { op: `fd-${string}` }>;

function isFdSyscall(req: WasmSyscall): req is FdSyscall {
  return req.op.startsWith('fd-');
}

const SYSCALL_OPS: ReadonlySet<string> = new Set([
  'fd-read',
  'fd-write',
  'fd-close',
  'fd-pipe',
  'fd-poll',
  'fd-open-vfs',
  'fd-seek',
  'fd-select',
  'fd-flush',
  'proc-spawn',
  'proc-wait',
  'proc-captured',
  'proc-fork',
  'proc-kill',
  'proc-exec',
  'sig-mask',
]);

/** Whether a SAB request is a process syscall (else it is a sync-fs / exec op). */
export function isWasmSyscall(req: object): req is WasmSyscall {
  const op = (req as { op?: unknown }).op;
  return typeof op === 'string' && SYSCALL_OPS.has(op);
}

/** Largest read one syscall serves: the SAB bridge drains bigger payloads in rounds anyway. */
const MAX_READ = 1024 * 1024;

export interface WasmProcessOptions {
  /** Starts the children it spawns. */
  spawner?: ChildSpawner;
  /** Starts the children it forks. */
  forker?: ChildForker;
  /** The filesystem its VFS file descriptions read and write. */
  fs?: VfsFileFs;
  /** kill(2) of another process: false when there is no such process (ESRCH). */
  kill?: (pid: number, sig: number) => boolean;
  /** A caught signal is pending: publish it where the worker looks after each syscall. */
  onPending?: (sig: number) => void;
  /** Whether a published signal still waits for the worker (it interrupts the next blocking call). */
  hasPending?: () => boolean;
}

/**
 * What the kernel does with a signal sent to a process: its default action,
 * delivery to its handler, or (while it execs) forwarding to the program.
 */
export type SignalOutcome = DefaultAction | 'deliver' | 'forward';

export class WasmProcess {
  private exited = false;
  private readonly children: ChildTable;
  /** Signals the program catches / ignores (bit n = signal n), as it last reported. */
  private caught = 0;
  private ignored = 0;
  /** Aborted by a caught signal: interrupts a blocked read, write or wait (EINTR). */
  private interrupt = new AbortController();
  /**
   * The program this process exec'd (spawned, and waits on as if replaced by
   * it): signals sent to this process go to that program.
   */
  private execChild: number | undefined;

  constructor(
    readonly pid: number,
    readonly fds: FdTable,
    private readonly options: WasmProcessOptions = {}
  ) {
    this.children = new ChildTable(fds, options.spawner, options.forker);
    this.children.onChildExit = () => this.signal(SIG.CHLD);
  }

  /**
   * A signal arrives. SIGKILL and an uncaught signal's default action are the
   * caller's to carry out (`terminate`); a caught one is left pending for the
   * worker, whose blocked syscall (if any) returns EINTR so it runs the handler.
   */
  signal(sig: number): SignalOutcome {
    if (this.execChild !== undefined) {
      this.options.kill?.(this.execChild, sig);
      return sig === SIG.KILL ? 'terminate' : 'forward';
    }
    if (sig === SIG.KILL) return 'terminate';
    const bit = sigbit(sig);
    if (this.ignored & bit) return 'ignore';
    if (!(this.caught & bit)) return defaultAction(sig);
    this.options.onPending?.(sig);
    const blocked = this.interrupt;
    this.interrupt = new AbortController();
    blocked.abort();
    return 'deliver';
  }

  async syscall(req: WasmSyscall): Promise<SyncFsResult> {
    try {
      return isFdSyscall(req) ? await this.fdSyscall(req) : await this.procSyscall(req);
    } catch (e) {
      if (e instanceof KernelError || e instanceof SpawnError) {
        return { ok: false, errno: e.code, message: e.code };
      }
      throw e;
    }
  }

  /**
   * The signal to interrupt a blocking call with. One already pending when the
   * call starts interrupts it at once: the worker runs the handler as the call
   * returns, as a real kernel does before sleeping.
   */
  private blockingSignal(): AbortSignal {
    if (this.options.hasPending?.()) throw new KernelError('EINTR');
    return this.interrupt.signal;
  }

  /** Descriptor syscalls: reads and writes a caught signal can interrupt. */
  private async fdSyscall(req: FdSyscall): Promise<SyncFsResult> {
    switch (req.op) {
      case 'fd-read': {
        const file = this.fds.get(req.fd).file;
        if (!file.read) throw new KernelError('EBADF');
        const max = Math.max(0, Math.min(req.max, MAX_READ));
        const signal = pollFile(file).readable ? this.interrupt.signal : this.blockingSignal();
        return { ok: true, kind: 'bytes', bytes: await file.read(max, signal) };
      }
      case 'fd-write': {
        const file = this.fds.get(req.fd).file;
        if (!file.write) throw new KernelError('EBADF');
        const signal = pollFile(file).writable ? this.interrupt.signal : this.blockingSignal();
        return { ok: true, kind: 'json', json: await file.write(req.body, signal) };
      }
      case 'fd-close':
        await Promise.resolve(this.fds.close(req.fd));
        return { ok: true, kind: 'void' };
      case 'fd-pipe': {
        const pipe = openPipe();
        const read = this.fds.install(pipe.read, 3);
        let write: number;
        try {
          write = this.fds.install(pipe.write, 3);
        } catch (e) {
          await Promise.resolve(this.fds.close(read));
          throw e;
        }
        return { ok: true, kind: 'json', json: [read, write] };
      }
      case 'fd-poll':
        return { ok: true, kind: 'json', json: pollFile(this.fds.get(req.fd).file) };
      case 'fd-open-vfs': {
        if (!this.options.fs) throw new SpawnError('ENOSYS');
        const file = vfsFile(this.options.fs, {
          path: req.path,
          flags: req.flags,
          position: req.position,
          ...(req.contents !== undefined ? { contents: req.contents } : {}),
          ...(req.orphan ? { orphan: true } : {}),
        });
        return { ok: true, kind: 'json', json: this.fds.install(file, 3) };
      }
      case 'fd-select': {
        const { read, write, timeoutMs } = req;
        const signal = this.blockingSignal();
        const selected = await selectFds(this.fds, read, write, timeoutMs, signal);
        return { ok: true, kind: 'json', json: selected };
      }
      case 'fd-seek': {
        const file = this.fds.get(req.fd).file;
        if (!file.seek) throw new KernelError('ESPIPE');
        return { ok: true, kind: 'json', json: await file.seek(req.offset, req.whence) };
      }
      case 'fd-flush': {
        const file = this.fds.get(req.fd).file;
        if (file.flush) await file.flush();
        return { ok: true, kind: 'void' };
      }
    }
  }

  /** Process and signal syscalls. */
  private async procSyscall(req: Exclude<WasmSyscall, FdSyscall>): Promise<SyncFsResult> {
    switch (req.op) {
      case 'proc-fork':
        return { ok: true, kind: 'json', json: await this.children.fork(req.state) };
      case 'proc-spawn': {
        const { file, argv, env, cwd, stdio } = req;
        const pid = await this.children.spawn({ file, argv, env, cwd }, stdio);
        return { ok: true, kind: 'json', json: pid };
      }
      case 'proc-wait': {
        const signal = req.nohang ? this.interrupt.signal : this.blockingSignal();
        const waited = await this.children.wait(req.pid, req.nohang, signal);
        return { ok: true, kind: 'json', json: waited };
      }
      case 'proc-exec': {
        // execve(): this process now stands for the program it spawned.
        this.execChild = req.pid;
        try {
          return { ok: true, kind: 'json', json: await this.children.wait(req.pid, false) };
        } finally {
          this.execChild = undefined;
        }
      }
      case 'proc-kill':
        if (req.sig !== 0 && !isSignal(req.sig)) throw new KernelError('EINVAL');
        if (!this.options.kill?.(req.pid, req.sig)) throw new KernelError('ESRCH');
        return { ok: true, kind: 'void' };
      case 'sig-mask':
        this.caught = req.caught;
        this.ignored = req.ignored;
        return { ok: true, kind: 'void' };
      case 'proc-captured':
        return { ok: true, kind: 'bytes', bytes: this.children.captured(req.pid, req.slot) };
    }
  }

  /** The process is gone (exit, crash, SIGKILL): release its descriptors once. */
  async exit(): Promise<void> {
    if (this.exited) return;
    this.exited = true;
    await this.fds.closeAll();
  }
}
