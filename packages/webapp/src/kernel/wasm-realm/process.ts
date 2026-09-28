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
  type InheritedSlot,
  SpawnError,
} from './children.js';
import { type FdTable, KernelError, openPipe, pollFile } from './fd-table.js';
import type { JobTable } from './jobs.js';
import type { ForkState } from './protocol.js';
import { selectFds } from './select.js';
import { type DefaultAction, defaultAction, isSignal, SIG, sigbit } from './signals.js';
import { LoopbackNet } from './socket.js';
import { SOCKET_OPS, type SocketSyscall, socketSyscall } from './socket-syscalls.js';
import type { KernelTty, Termios } from './tty.js';
import { type VfsFileFs, vfsFile } from './vfs-file.js';

/** The syscalls of a wasm-realm process (the request bodies on the SAB wire). */
export type WasmSyscall =
  | {
      op: 'fd-read';
      fd: number;
      max: number;
      /** O_NONBLOCK / MSG_DONTWAIT: EAGAIN instead of waiting. */
      nonblock?: boolean;
      /** recv's MSG_PEEK: the bytes stay to be read again. */
      peek?: boolean;
    }
  | { op: 'fd-write'; fd: number; body: Uint8Array; nonblock?: boolean }
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
  | { op: 'fd-info'; fd: number }
  | { op: 'tty-get'; fd: number }
  | { op: 'tty-set'; fd: number; termios: Termios }
  | { op: 'tty-winsz'; fd: number }
  | { op: 'fd-flush'; fd: number }
  | {
      op: 'proc-spawn';
      file: string;
      argv: string[];
      env: Record<string, string>;
      cwd: string;
      stdio: ChildStdio[];
      /** The program's fds beyond 0-2 the child inherits (not close-on-exec). */
      inherit?: InheritedSlot[];
    }
  | {
      op: 'proc-wait';
      pid: number;
      nohang: boolean;
      /** WUNTRACED / WCONTINUED: report stops and continues too. */
      untraced?: boolean;
      continued?: boolean;
    }
  | { op: 'proc-captured'; pid: number; slot: number }
  | { op: 'proc-fork'; state: ForkState }
  | { op: 'proc-kill'; pid: number; sig: number }
  | { op: 'proc-exec'; pid: number }
  | { op: 'proc-setpgid'; pid: number; pgid: number }
  | { op: 'proc-getpgid'; pid: number }
  | { op: 'proc-getsid'; pid: number }
  | { op: 'proc-setsid' }
  | { op: 'tty-pgrp-get'; fd: number }
  | { op: 'tty-pgrp-set'; fd: number; pgrp: number }
  | { op: 'sig-mask'; caught: number; ignored: number }
  | SocketSyscall;

/** The syscalls on a descriptor. */
type FdSyscall = Extract<WasmSyscall, { op: `fd-${string}` }>;

/** The process-group and session syscalls. */
type JobSyscall = Extract<
  WasmSyscall,
  { op: 'proc-setpgid' | 'proc-getpgid' | 'proc-getsid' | 'proc-setsid' }
>;

const JOB_OPS: ReadonlySet<string> = new Set([
  'proc-setpgid',
  'proc-getpgid',
  'proc-getsid',
  'proc-setsid',
]);

function isJobSyscall(req: WasmSyscall): req is JobSyscall {
  return JOB_OPS.has(req.op);
}

function isSocketSyscall(req: WasmSyscall): req is SocketSyscall {
  return req.op.startsWith('sock-');
}

function isFdSyscall(req: WasmSyscall): req is FdSyscall {
  return req.op.startsWith('fd-');
}

function isTtySyscall(req: WasmSyscall): req is TtySyscall {
  return req.op.startsWith('tty-');
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
  'fd-info',
  'tty-get',
  'tty-set',
  'tty-winsz',
  'fd-flush',
  'proc-spawn',
  'proc-wait',
  'proc-captured',
  'proc-fork',
  'proc-kill',
  'proc-exec',
  'proc-setpgid',
  'proc-getpgid',
  'proc-getsid',
  'proc-setsid',
  'tty-pgrp-get',
  'tty-pgrp-set',
  'sig-mask',
  ...SOCKET_OPS,
]);

/** Whether a SAB request is a process syscall (else it is a sync-fs / exec op). */
/** Descriptor syscalls, plus the terminal ones (which also name an fd). */
type TtySyscall = Extract<WasmSyscall, { op: `tty-${string}` }>;

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
  kill?: (pid: number, sig: number) => boolean | Promise<boolean>;
  /** A caught signal is pending: publish it where the worker looks after each syscall. */
  onPending?: (sig: number) => void;
  /** Whether a published signal still waits for the worker (it interrupts the next blocking call). */
  hasPending?: () => boolean;
  /** Process groups, sessions and terminal foreground of its invocation (job control). */
  jobs?: JobTable;
  /** The loopback network its sockets live on (its owner's); a private one when absent. */
  net?: LoopbackNet;
}

/** A stop or continue, for the parent's waitpid(WUNTRACED) and SIGCHLD. */
export type StateListener = (state: 'stopped' | 'continued', sig: number) => void;

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
  /**
   * The signal the program this process exec'd died of: the process stands
   * for that program, so its parent sees it end by the same signal.
   */
  execTermsig: number | undefined;
  /** The signal that stopped it (0 while running): its syscalls wait for SIGCONT. */
  private stopped = 0;
  /** Stops so far: a blocking call a stop interrupted runs again once continued. */
  private stops = 0;
  private resumed: Promise<void> = Promise.resolve();
  private wake: () => void = () => {};
  private readonly stateListeners: StateListener[] = [];
  private net: LoopbackNet | undefined;

  constructor(
    readonly pid: number,
    readonly fds: FdTable,
    private readonly options: WasmProcessOptions = {}
  ) {
    this.children = new ChildTable(fds, options.spawner, options.forker);
    this.children.onChildState = () => this.signal(SIG.CHLD);
  }

  /**
   * A signal arrives. SIGKILL and an uncaught signal's default action are the
   * caller's to carry out (`terminate`); a caught one is left pending for the
   * worker, whose blocked syscall (if any) returns EINTR so it runs the handler.
   */
  signal(sig: number): SignalOutcome {
    if (this.execChild !== undefined) {
      // The program is of this invocation: its kill never waits on the policy.
      void Promise.resolve(this.options.kill?.(this.execChild, sig)).catch(() => undefined);
      return sig === SIG.KILL ? 'terminate' : 'forward';
    }
    if (sig === SIG.KILL) return 'terminate';
    // SIGCONT resumes a stopped process whatever its disposition; SIGSTOP cannot be caught.
    if (sig === SIG.CONT) this.cont();
    if (sig === SIG.STOP) return this.stop(sig);
    const bit = sigbit(sig);
    if (this.ignored & bit) return 'ignore';
    if (!(this.caught & bit)) {
      const action = defaultAction(sig);
      return action === 'stop' ? this.stop(sig) : action;
    }
    this.options.onPending?.(sig);
    const blocked = this.interrupt;
    this.interrupt = new AbortController();
    blocked.abort();
    return 'deliver';
  }

  /** Hear of its stops and continues (its parent's waitpid(WUNTRACED), SIGCHLD). */
  onState(listener: StateListener): void {
    this.stateListeners.push(listener);
  }

  /**
   * Stop: its syscalls (and the reply to one in flight) wait for SIGCONT. A
   * blocked call is interrupted, to run again once continued: a stopped
   * process must not go on taking the terminal's input, say.
   */
  private stop(sig: number): 'stop' {
    if (this.stopped) return 'stop';
    this.stopped = sig;
    this.stops++;
    this.resumed = new Promise((resolve) => (this.wake = resolve));
    const blocked = this.interrupt;
    this.interrupt = new AbortController();
    blocked.abort();
    for (const listener of this.stateListeners) listener('stopped', sig);
    return 'stop';
  }

  private cont(): void {
    if (!this.stopped) return;
    this.stopped = 0;
    this.wake();
    for (const listener of this.stateListeners) listener('continued', SIG.CONT);
  }

  async syscall(req: WasmSyscall): Promise<SyncFsResult> {
    for (;;) {
      await this.resumed;
      const stops = this.stops;
      const result = await this.dispatch(req);
      // Interrupted by a stop, not for a handler: it runs again once continued.
      const restart = !result.ok && result.errno === 'EINTR' && this.stops !== stops;
      if (restart && !this.options.hasPending?.()) continue;
      // Stopped while the call ran: the answer waits too.
      await this.resumed;
      return result;
    }
  }

  private async dispatch(req: WasmSyscall): Promise<SyncFsResult> {
    try {
      if (isFdSyscall(req)) return await this.fdSyscall(req);
      if (isTtySyscall(req)) return this.ttySyscall(req);
      if (isJobSyscall(req)) return this.jobSyscall(req);
      if (isSocketSyscall(req)) return await this.socketSyscall(req);
      return await this.procSyscall(req);
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

  private async read(req: Extract<WasmSyscall, { op: 'fd-read' }>): Promise<Uint8Array> {
    const file = this.fds.get(req.fd).file;
    const read = req.peek ? file.peek : file.read;
    if (!read) throw new KernelError(req.peek && file.read ? 'EOPNOTSUPP' : 'EBADF');
    if (file.tty) this.checkForeground(file.tty);
    // read(fd, buf, 0) / recv(..., 0): nothing to wait for, blocking or not.
    if (req.max <= 0) return new Uint8Array(0);
    const ready = pollFile(file).readable;
    if (!ready && req.nonblock) throw new KernelError('EAGAIN');
    const signal = ready ? this.interrupt.signal : this.blockingSignal();
    return read.call(file, Math.max(0, Math.min(req.max, MAX_READ)), signal);
  }

  private async write(fd: number, body: Uint8Array, nonblock = false): Promise<number> {
    const file = this.fds.get(fd).file;
    if (!file.write) throw new KernelError('EBADF');
    if (!pollFile(file).writable) {
      if (nonblock) throw new KernelError('EAGAIN');
      return file.write(body, this.blockingSignal());
    }
    // Non-blocking: what fits now, a short count (an aborted signal ends the write at the first wait).
    if (nonblock) return file.write(body, AbortSignal.abort());
    // Room for some of it: with a signal pending, the write takes what fits
    // and returns that short count instead of waiting for the rest.
    return file.write(
      body,
      this.options.hasPending?.() ? AbortSignal.abort() : this.interrupt.signal
    );
  }

  /** Descriptor syscalls: reads and writes a caught signal can interrupt. */
  private async fdSyscall(req: FdSyscall): Promise<SyncFsResult> {
    switch (req.op) {
      case 'fd-read':
        return { ok: true, kind: 'bytes', bytes: await this.read(req) };
      case 'fd-write':
        return { ok: true, kind: 'json', json: await this.write(req.fd, req.body, req.nonblock) };
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
      case 'fd-info':
        return {
          ok: true,
          kind: 'json',
          json: { tty: this.fds.get(req.fd).file.tty !== undefined },
        };
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

  /** Terminal syscalls: termios, window size and foreground group of an fd that is a terminal (else ENOTTY). */
  private ttySyscall(req: TtySyscall): SyncFsResult {
    const tty = this.tty(req.fd);
    const jobs = this.options.jobs;
    switch (req.op) {
      case 'tty-get':
        return { ok: true, kind: 'json', json: tty.tcgets() };
      case 'tty-set':
        tty.tcsets(req.termios);
        return { ok: true, kind: 'void' };
      case 'tty-winsz':
        return { ok: true, kind: 'json', json: tty.winsize() };
      case 'tty-pgrp-get':
        return { ok: true, kind: 'json', json: jobs ? jobs.tcgetpgrp(tty, this.sid()) : this.pid };
      case 'tty-pgrp-set':
        if (jobs) jobs.tcsetpgrp(this.pid, tty, req.pgrp);
        else if (req.pgrp !== this.pid) throw new KernelError('EPERM');
        return { ok: true, kind: 'void' };
    }
  }

  /**
   * A read of the terminal by a process outside its foreground group: SIGTTIN
   * to the process's group, which stops it (the read runs again once it is
   * continued in the foreground); EIO when it ignores the signal.
   */
  private checkForeground(tty: KernelTty): void {
    const jobs = this.options.jobs;
    if (!jobs) return;
    const pgid = this.pgid();
    if (jobs.tcgetpgrp(tty, this.sid()) === pgid) return;
    if (this.ignored & sigbit(SIG.TTIN)) throw new KernelError('EIO');
    jobs.killGroup(pgid, SIG.TTIN);
    throw new KernelError('EINTR');
  }

  /** waitpid(0) waits for the caller's group, waitpid(-pgid) for that group. */
  private waitGroup(pid: number): ((child: number) => boolean) | undefined {
    const jobs = this.options.jobs;
    if (!jobs || pid > 0 || pid === -1) return undefined;
    const group = pid === 0 ? this.pgid() : -pid;
    // A child the table does not know started in this process's group.
    return (child) => (jobs.pgidOf(child) ?? this.pgid()) === group;
  }

  private pgid(): number {
    return this.options.jobs?.getpgid(this.pid, 0) ?? this.pid;
  }

  private sid(): number {
    return this.options.jobs?.getsid(this.pid, 0) ?? this.pid;
  }

  /** Process groups and sessions: without a job table, each process is its own. */
  private jobSyscall(req: JobSyscall): SyncFsResult {
    const jobs = this.options.jobs;
    const self = (pid: number): number => {
      if (pid !== 0 && pid !== this.pid) throw new KernelError('ESRCH');
      return this.pid;
    };
    switch (req.op) {
      case 'proc-setpgid':
        if (jobs) jobs.setpgid(this.pid, req.pid, req.pgid);
        else if (self(req.pid) !== (req.pgid || this.pid)) throw new KernelError('EPERM');
        return { ok: true, kind: 'void' };
      case 'proc-getpgid':
        return { ok: true, kind: 'json', json: jobs?.getpgid(this.pid, req.pid) ?? self(req.pid) };
      case 'proc-getsid':
        return { ok: true, kind: 'json', json: jobs?.getsid(this.pid, req.pid) ?? self(req.pid) };
      case 'proc-setsid':
        if (!jobs) throw new KernelError('EPERM');
        return { ok: true, kind: 'json', json: jobs.setsid(this.pid) };
    }
  }

  private tty(fd: number): KernelTty {
    const tty = this.fds.get(fd).file.tty;
    if (!tty) throw new KernelError('ENOTTY');
    return tty;
  }

  /** Socket syscalls, on the owner's loopback network (a private one without). */
  private socketSyscall(req: SocketSyscall): Promise<SyncFsResult> {
    this.net ??= this.options.net ?? new LoopbackNet();
    return socketSyscall(req, {
      fds: this.fds,
      net: this.net,
      blocking: () => this.blockingSignal(),
    });
  }

  /** Process and signal syscalls. */
  private async procSyscall(
    req: Exclude<WasmSyscall, FdSyscall | TtySyscall | JobSyscall | SocketSyscall>
  ): Promise<SyncFsResult> {
    switch (req.op) {
      case 'proc-fork':
        return { ok: true, kind: 'json', json: await this.children.fork(req.state) };
      case 'proc-spawn': {
        const { file, argv, env, cwd, stdio, inherit } = req;
        const pid = await this.children.spawn({ file, argv, env, cwd }, stdio, inherit);
        return { ok: true, kind: 'json', json: pid };
      }
      case 'proc-wait': {
        const signal = req.nohang ? this.interrupt.signal : this.blockingSignal();
        const flags = {
          untraced: req.untraced,
          continued: req.continued,
          inGroup: this.waitGroup(req.pid),
        };
        const waited = await this.children.wait(req.pid, req.nohang, signal, flags);
        return { ok: true, kind: 'json', json: waited };
      }
      case 'proc-exec': {
        // execve(): this process now stands for the program it spawned.
        this.execChild = req.pid;
        this.options.jobs?.exec(this.pid, req.pid);
        // The program stands for this process: its parent sees it stop and continue.
        this.children.watch(req.pid, (state, sig) =>
          state === 'stopped' ? this.stop(sig) : this.cont()
        );
        try {
          const waited = await this.children.wait(req.pid, false);
          const termsig = waited[1] & 0x7f;
          if (termsig) this.execTermsig = termsig;
          return { ok: true, kind: 'json', json: waited };
        } finally {
          this.execChild = undefined;
        }
      }
      case 'proc-kill':
        if (req.sig !== 0 && !isSignal(req.sig)) throw new KernelError('EINVAL');
        // kill(0, sig): the caller's own group; a negative pid names a group.
        if (!(await this.options.kill?.(req.pid === 0 ? -this.pgid() : req.pid, req.sig))) {
          throw new KernelError('ESRCH');
        }
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
