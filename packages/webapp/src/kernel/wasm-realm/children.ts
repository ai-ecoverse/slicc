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

export interface ChildSpawnRequest {
  file: string;

  argv: string[];
  env: Record<string, string>;
  cwd: string;
}

export interface ChildHandle {
  pid: number;

  exited: Promise<number>;
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

  code?: number;

  captured: Map<number, Uint8Array[]>;
}

export function waitStatus(code: number): number {
  return (code & 0xff) << 8;
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

  constructor(
    private readonly parentFds: FdTable,
    private readonly spawner: ChildSpawner | undefined,
    private readonly forker?: ChildForker
  ) {}

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
    const child: Child = { exited: handle.exited, captured };
    void handle.exited.then((code) => {
      child.code = code;
    });
    this.children.set(handle.pid, child);
    return handle.pid;
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

  async wait(pid: number, nohang: boolean): Promise<[number, number]> {
    const candidates = pid > 0 ? [...this.children].filter(([p]) => p === pid) : [...this.children];
    if (candidates.length === 0) throw new KernelError('ECHILD');
    const done = candidates.find(([, child]) => child.code !== undefined);
    if (done) return this.reap(done[0], done[1].code as number);
    if (nohang) return [0, 0];
    const [reaped, code] = await Promise.race(
      candidates.map(([p, child]) => child.exited.then((c) => [p, c] as const))
    );
    return this.reap(reaped, code);
  }

  private reap(pid: number, code: number): [number, number] {
    const child = this.children.get(pid);
    this.children.delete(pid);
    if (child && child.captured.size > 0) this.leftovers.set(pid, child.captured);
    return [pid, waitStatus(code)];
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
