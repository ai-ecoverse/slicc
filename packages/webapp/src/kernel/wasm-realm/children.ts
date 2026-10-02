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

export type ChildStdio =
  | { fd: number }
  | { input: Uint8Array }
  | { capture: true }
  | { none: true };

export type InheritedSlot =
  | { fd: number; kernel: number; flags?: number }
  | { fd: number; null: true };

export interface ChildSpawnRequest {
  file: string;

  argv: string[];
  env: Record<string, string>;
  cwd: string;
}

export interface ChildHandle {
  pid: number;

  exited: Promise<number>;

  termsig?: () => number | undefined;

  onState?: (listener: ChildStateListener) => void;
}

export type ChildStateListener = (state: 'stopped' | 'continued', sig: number) => void;

export interface WaitFlags {
  untraced?: boolean;

  continued?: boolean;

  inGroup?: (childPid: number) => boolean;
}

export class SpawnError extends Error {
  constructor(readonly code: KernelErrno) {
    super(code);
  }
}

export type ChildSpawner = (req: ChildSpawnRequest, fds: FdTable) => Promise<ChildHandle>;

export type ChildForker = (state: ForkState, fds: FdTable) => Promise<ChildHandle>;

interface Child {
  exited: Promise<number>;
  termsig?: () => number | undefined;

  code?: number;

  stopReport?: number;

  continueReport?: boolean;

  captured: Map<number, Uint8Array[]>;
}

function interrupted(signal: AbortSignal | undefined): {
  promise: Promise<never>;

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

export function stoppedStatus(sig: number): number {
  return ((sig & 0xff) << 8) | 0x7f;
}

export const CONTINUED_STATUS = 0xffff;

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

  private readonly leftovers = new Map<number, Map<number, Uint8Array[]>>();

  onChildState?: () => void;

  private stateChanged: Array<() => void> = [];

  private readonly watchers = new Map<number, ChildStateListener>();

  constructor(
    private readonly parentFds: FdTable,
    private readonly spawner: ChildSpawner | undefined,
    private readonly forker?: ChildForker
  ) {}

  async fork(state: ForkState): Promise<number> {
    if (!this.forker) throw new SpawnError('ENOSYS');
    return this.track(state, this.parentFds.fork(), new Map(), this.forker);
  }

  async spawn(
    req: ChildSpawnRequest,
    stdio: readonly ChildStdio[],
    inherit: readonly InheritedSlot[] = []
  ): Promise<number> {
    if (!this.spawner) throw new SpawnError('ENOSYS');
    const fds = new FdTable();
    const captured = new Map<number, Uint8Array[]>();
    try {
      for (const [n, slot] of stdio.entries()) fds.installAt(n, this.openSlot(slot, n, captured));

      for (const slot of inherit) {
        if (slot.fd <= 2) continue;
        if ('null' in slot) {
          fds.installAt(slot.fd, nullFile());
          continue;
        }
        fds.installAt(slot.fd, this.parentFds.get(slot.kernel).retain());
        if (slot.flags !== undefined) fds.setStatusFlags(slot.fd, slot.flags);
      }
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

  async wait(
    pid: number,
    nohang: boolean,
    signal?: AbortSignal,
    flags: WaitFlags = {}
  ): Promise<[number, number]> {
    let interrupt: ReturnType<typeof interrupted> | undefined;
    try {
      for (;;) {
        const candidates = this.candidates(pid, flags);
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

  private candidates(pid: number, flags: WaitFlags): [number, Child][] {
    const all = [...this.children];
    if (pid > 0) return all.filter(([p]) => p === pid);
    const inGroup = flags.inGroup;
    return pid === -1 || !inGroup ? all : all.filter(([p]) => inGroup(p));
  }

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

  captured(pid: number, slot: number): Uint8Array {
    const slots = this.leftovers.get(pid);
    const chunks = slots?.get(slot);
    if (!slots || !chunks) return new Uint8Array(0);
    slots.delete(slot);
    if (slots.size === 0) this.leftovers.delete(pid);
    return concat(chunks);
  }
}
