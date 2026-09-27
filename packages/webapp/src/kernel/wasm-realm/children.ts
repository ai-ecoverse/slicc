/**
 * `children.ts` — the child processes of a wasm-realm process (#3530):
 * `posix_spawn` and `waitpid` as the kernel serves them.
 *
 * The kernel does not decide what a program name means: the spawner that
 * started the parent (the `wasm` command) resolves it — an installed wasm
 * program becomes another wasm-realm process, anything else runs through the
 * shell — and hands back a {@link ChildHandle}. The kernel builds the child's
 * descriptors from the parent's and keeps each child's exit status until the
 * parent waits for it.
 *
 * A child's stdio slot is one of the parent's kernel fds (shared: the child
 * runs concurrently and writes where the parent would), `/dev/null`, bytes the
 * parent hands over as its stdin, or a capture buffer the parent collects
 * after waiting — for a descriptor that lives only inside the parent's
 * program (a file or pipe of its Emscripten FS).
 */
import {
  bytesSource,
  FdTable,
  type KernelErrno,
  KernelError,
  nullFile,
  type OpenFile,
  sinkFile,
} from './fd-table.js';
import type { ForkState } from './protocol.js';

/** A child's stdio slot, from the parent's point of view. */
export type ChildStdio =
  | { fd: number }
  | { input: Uint8Array }
  | { capture: true }
  | { none: true };

export interface ChildSpawnRequest {
  /** The program: a name or a path, as the parent passed it. */
  file: string;
  /** Its full argv, `argv[0]` included. */
  argv: string[];
  env: Record<string, string>;
  cwd: string;
}

export interface ChildHandle {
  pid: number;
  /** Resolves to the exit code. */
  exited: Promise<number>;
  /** The signal that ended it, if one did (reported as WIFSIGNALED). */
  termsig?: () => number | undefined;
  /** Hear of its stops and continues (waitpid's WUNTRACED / WCONTINUED). */
  onState?: (listener: ChildStateListener) => void;
}

/** A child stopped (by `sig`) or continued. */
export type ChildStateListener = (state: 'stopped' | 'continued', sig: number) => void;

/** waitpid options beyond WNOHANG. */
export interface WaitFlags {
  /** WUNTRACED: report a child that stopped. */
  untraced?: boolean;
  /** WCONTINUED: report a stopped child that continued. */
  continued?: boolean;
}

/** The child could not be started (`ENOENT`: nothing runs the program; `ENOSYS`: no spawner). */
export class SpawnError extends Error {
  constructor(readonly code: KernelErrno) {
    super(code);
  }
}

/**
 * Start a child whose descriptors are `fds` (it takes them over).
 * Rejects with {@link SpawnError} when there is nothing to run.
 */
export type ChildSpawner = (req: ChildSpawnRequest, fds: FdTable) => Promise<ChildHandle>;

/** Start a forked copy of the parent from `state`, on a copy of its descriptor table. */
export type ChildForker = (state: ForkState, fds: FdTable) => Promise<ChildHandle>;

interface Child {
  exited: Promise<number>;
  termsig?: () => number | undefined;
  /** Set once the child has exited. */
  code?: number;
  /** The signal that stopped it, until a WUNTRACED wait reports it. */
  stopReport?: number;
  /** Continued, until a WCONTINUED wait reports it. */
  continueReport?: boolean;
  /** Capture buffers by stdio slot. */
  captured: Map<number, Uint8Array[]>;
}

/** Rejects with EINTR when `signal` aborts (a caught signal interrupts a wait); never resolves. */
function interrupted(signal: AbortSignal | undefined): {
  promise: Promise<never>;
  /** Detach from `signal`: the wait is over (it outlives many waits). */
  done(): void;
} {
  let fail = (): void => {};
  const promise = new Promise<never>((_, reject) => {
    fail = () => reject(new KernelError('EINTR'));
    if (signal?.aborted) fail();
    else signal?.addEventListener('abort', fail, { once: true });
  });
  return { promise, done: () => signal?.removeEventListener('abort', fail) };
}

/** The wait status of a stopped process (`WIFSTOPPED`, `WSTOPSIG`). */
export function stoppedStatus(sig: number): number {
  return ((sig & 0xff) << 8) | 0x7f;
}

/** The wait status of a continued process (`WIFCONTINUED`). */
export const CONTINUED_STATUS = 0xffff;

/** A wait status: the signal that ended the process (`WTERMSIG`), else its exit code (`WEXITSTATUS`). */
export function waitStatus(code: number, termsig?: number): number {
  return termsig ? termsig & 0x7f : (code & 0xff) << 8;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export class ChildTable {
  private readonly children = new Map<number, Child>();
  /** Captured output of children already waited for, by pid. */
  private readonly leftovers = new Map<number, Map<number, Uint8Array[]>>();

  /** Called when a child exits, stops or continues (the parent's SIGCHLD). */
  onChildState?: () => void;
  /** Wakes the waits that also take a stop or continue. */
  private stateChanged: Array<() => void> = [];
  /** Listeners for one child's stops and continues (an exec'd program's, mirrored by its process). */
  private readonly watchers = new Map<number, ChildStateListener>();

  constructor(
    private readonly parentFds: FdTable,
    private readonly spawner: ChildSpawner | undefined,
    private readonly forker?: ChildForker
  ) {}

  /** fork(2): the child gets every descriptor of the parent (each gains a reference). */
  async fork(state: ForkState): Promise<number> {
    if (!this.forker) throw new SpawnError('ENOSYS');
    return this.track(state, this.parentFds.fork(), new Map(), this.forker);
  }

  async spawn(req: ChildSpawnRequest, stdio: readonly ChildStdio[]): Promise<number> {
    if (!this.spawner) throw new SpawnError('ENOSYS');
    const fds = new FdTable();
    const captured = new Map<number, Uint8Array[]>();
    try {
      for (const [n, slot] of stdio.entries()) fds.installAt(n, this.openSlot(slot, n, captured));
    } catch (e) {
      await fds.closeAll();
      throw e;
    }
    return this.track(req, fds, captured, this.spawner);
  }

  private async track<R>(
    req: R,
    fds: FdTable,
    captured: Map<number, Uint8Array[]>,
    start: (req: R, fds: FdTable) => Promise<ChildHandle>
  ): Promise<number> {
    let handle: ChildHandle;
    try {
      handle = await start(req, fds);
    } catch (e) {
      await fds.closeAll();
      throw e;
    }
    const child: Child = { exited: handle.exited, termsig: handle.termsig, captured };
    void handle.exited.then((code) => {
      child.code = code;
      this.watchers.delete(handle.pid);
      this.onChildState?.();
    });
    handle.onState?.((state, sig) => {
      child.stopReport = state === 'stopped' ? sig : undefined;
      child.continueReport = state === 'continued';
      this.watchers.get(handle.pid)?.(state, sig);
      const waiters = this.stateChanged;
      this.stateChanged = [];
      for (const wake of waiters) wake();
      this.onChildState?.();
    });
    this.children.set(handle.pid, child);
    return handle.pid;
  }

  /** Follow child `pid`'s stops and continues (until it exits). */
  watch(pid: number, listener: ChildStateListener): void {
    if (this.children.has(pid)) this.watchers.set(pid, listener);
  }

  private openSlot(slot: ChildStdio, n: number, captured: Map<number, Uint8Array[]>): OpenFile {
    if ('fd' in slot) return this.parentFds.get(slot.fd).retain();
    if ('input' in slot) return bytesSource(slot.input);
    if ('capture' in slot) {
      const chunks: Uint8Array[] = [];
      captured.set(n, chunks);
      return sinkFile((bytes) => chunks.push(bytes));
    }
    return nullFile();
  }

  /**
   * waitpid: `pid` > 0 waits for that child, otherwise for any. Resolves to
   * `[pid, status]`; `[0, 0]` when `nohang` and none has exited. ECHILD when
   * there is no such child. With `flags`, a stop or continue not yet
   * reported counts too (the child stays in the table).
   */
  async wait(
    pid: number,
    nohang: boolean,
    signal?: AbortSignal,
    flags: WaitFlags = {}
  ): Promise<[number, number]> {
    let interrupt: ReturnType<typeof interrupted> | undefined;
    try {
      for (;;) {
        const candidates =
          pid > 0 ? [...this.children].filter(([p]) => p === pid) : [...this.children];
        if (candidates.length === 0) throw new KernelError('ECHILD');
        const done = candidates.find(([, child]) => child.code !== undefined);
        if (done) return this.reap(done[0], done[1].code as number);
        const changed = this.stateReport(candidates, flags);
        if (changed) return changed;
        if (nohang) return [0, 0];
        interrupt ??= interrupted(signal);
        await this.nextChange(candidates, flags, interrupt.promise);
      }
    } finally {
      interrupt?.done();
    }
  }

  /** Until a candidate exits, stops or continues (as `flags` asks), or the wait is interrupted. */
  private async nextChange(
    candidates: [number, Child][],
    flags: WaitFlags,
    interrupt: Promise<never>
  ): Promise<void> {
    let wake: (() => void) | undefined;
    const stateChange = new Promise<void>((resolve) => (wake = resolve));
    const watching = flags.untraced || flags.continued;
    if (watching && wake) this.stateChanged.push(wake);
    try {
      await Promise.race([
        ...candidates.map(([, child]) => child.exited),
        ...(watching ? [stateChange] : []),
        interrupt,
      ]);
    } finally {
      this.stateChanged = this.stateChanged.filter((w) => w !== wake);
    }
  }

  /** A stop (WUNTRACED) or continue (WCONTINUED) to report, once. */
  private stateReport(candidates: [number, Child][], flags: WaitFlags): [number, number] | null {
    for (const [p, child] of candidates) {
      if (flags.untraced && child.stopReport !== undefined) {
        const sig = child.stopReport;
        child.stopReport = undefined;
        return [p, stoppedStatus(sig)];
      }
      if (flags.continued && child.continueReport) {
        child.continueReport = false;
        return [p, CONTINUED_STATUS];
      }
    }
    return null;
  }

  private reap(pid: number, code: number): [number, number] {
    const child = this.children.get(pid);
    this.children.delete(pid);
    if (child && child.captured.size > 0) this.leftovers.set(pid, child.captured);
    return [pid, waitStatus(code, child?.termsig?.())];
  }

  /** What a waited-for child wrote to its capture slot `slot` (once). */
  captured(pid: number, slot: number): Uint8Array {
    const slots = this.leftovers.get(pid);
    const chunks = slots?.get(slot);
    if (!slots || !chunks) return new Uint8Array(0);
    slots.delete(slot);
    if (slots.size === 0) this.leftovers.delete(pid);
    return concat(chunks);
  }
}
