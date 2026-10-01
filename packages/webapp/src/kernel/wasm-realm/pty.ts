/**
 * `pty.ts` — pseudo-terminals for wasm-realm processes: `/dev/ptmx` opens a
 * master, `/dev/pts/N` its slave (what a terminal multiplexer such as GNU
 * screen, or a program driving another one, stands on).
 *
 * The slave is a {@link KernelTty} — the line discipline, termios, window
 * size and job control of the panel's terminal — whose screen is the master:
 * what the slave writes (with its output processing and echo) is what the
 * master reads, and what the master writes is typed on the slave.
 *
 * - `/dev/ptmx` makes a new pair, locked until `unlockpt` (TIOCSPTLCK 0);
 *   `ptsname` reads its number (TIOCGPTN). Opening a locked slave is EIO.
 * - A session leader without a controlling terminal that opens the slave
 *   (without O_NOCTTY), or asks for it (TIOCSCTTY), gets it as `/dev/tty`.
 * - The master closed: the slave's foreground group gets SIGHUP and its
 *   reads end (end of file). Every slave descriptor closed: the master's
 *   reads fail with EIO, as on Linux, which is how screen sees a window end.
 * - The number is free again once neither side is open.
 * - Packet mode (TIOCPKT, which screen sets on every window's master): each
 *   read of the master starts with a status byte, here always TIOCPKT_DATA
 *   (0) — there is no flow control to report.
 */

import type { SyncFsResult } from '../realm/sync-fs-wire.js';
import { type FdTable, KernelError, OpenFile, type PollState } from './fd-table.js';
import type { JobTable } from './jobs.js';
import { KernelTty } from './tty.js';

/** Where a pseudo-terminal's signals go: its foreground group (the job table's). */
export type PtySignal = (tty: KernelTty, sig: number) => void;

export class PtyPair {
  readonly slave: KernelTty;
  /** Until `unlockpt`, the slave cannot be opened. */
  locked = true;
  /** TIOCPKT: each master read starts with a status byte. */
  packet = false;
  private queue: Uint8Array[] = [];
  private waiters: Array<() => void> = [];
  private masterOpen = true;
  private slaveRefs = 0;
  private slaveSeen = false;

  constructor(
    readonly index: number,
    signal: PtySignal,
    private readonly onFree: (pair: PtyPair) => void
  ) {
    this.slave = new KernelTty({ write: (bytes) => this.fromSlave(bytes) }, (sig) =>
      signal(this.slave, sig)
    );
    this.slave.name = `/dev/pts/${index}`;
  }

  /** The master side: one open file description (`/dev/ptmx`). */
  master(): OpenFile {
    return new OpenFile({
      read: (max, signal) => this.readMaster(max, signal),
      write: async (bytes) => {
        this.slave.receive(bytes);
        return bytes.length;
      },
      poll: (): PollState => ({
        readable: this.queue.length > 0 || this.slaveGone,
        writable: true,
        hangup: this.slaveGone,
      }),
      changed: (signal) => this.changed(signal),
      close: () => this.closeMaster(),
      pty: this,
    });
  }

  /** A new open of the slave (`/dev/pts/N`): the terminal, counted so the master sees it go. */
  openSlave(): OpenFile {
    if (!this.masterOpen || this.locked) throw new KernelError('EIO');
    const file = this.slave.file().file;
    this.slaveRefs += 1;
    this.slaveSeen = true;
    return new OpenFile({ ...file, close: () => this.closeSlave() });
  }

  /** Every slave descriptor that was opened is closed again (what the master's EIO reports). */
  private get slaveGone(): boolean {
    return this.slaveSeen && this.slaveRefs === 0;
  }

  private fromSlave(bytes: Uint8Array): void {
    if (!this.masterOpen) return; // nobody reads it any more
    this.queue.push(bytes.slice());
    this.wake();
  }

  private async readMaster(max: number, signal?: AbortSignal): Promise<Uint8Array> {
    while (this.queue.length === 0) {
      if (this.slaveGone) throw new KernelError('EIO');
      await this.changed(signal);
    }
    // In packet mode the status byte (TIOCPKT_DATA) takes one of the bytes asked for.
    const status = this.packet ? 1 : 0;
    const chunks: Uint8Array[] = [];
    let n = 0;
    while (this.queue.length > 0 && n < max - status) {
      const next = this.queue[0] as Uint8Array;
      const take = next.subarray(0, max - status - n);
      chunks.push(take);
      n += take.length;
      if (take.length < next.length) this.queue[0] = next.subarray(take.length);
      else this.queue.shift();
    }
    const out = new Uint8Array(status + n);
    let at = status;
    for (const chunk of chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }

  private closeMaster(): void {
    this.masterOpen = false;
    this.queue = [];
    // The terminal hangs up: its processes hear it, and their reads end.
    this.slave.hangup();
    this.slave.signalHangup();
    this.freeIfUnused();
  }

  private closeSlave(): void {
    this.slaveRefs -= 1;
    this.wake();
    this.freeIfUnused();
  }

  private freeIfUnused(): void {
    if (!this.masterOpen && this.slaveRefs === 0) this.onFree(this);
  }

  private changed(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new KernelError('EINTR'));
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new KernelError('EINTR'));
      };
      const waiter = (): void => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      this.waiters.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }
}

/** The pseudo-terminals of one invocation's processes, by number. */
export class PtyTable {
  private readonly pairs = new Map<number, PtyPair>();

  constructor(private readonly signal: PtySignal) {}

  /** `/dev/ptmx`: a new pair under the lowest free number; its master. */
  open(): { pair: PtyPair; master: OpenFile } {
    let index = 0;
    while (this.pairs.has(index)) index += 1;
    const pair = new PtyPair(index, this.signal, (p) => this.pairs.delete(p.index));
    this.pairs.set(index, pair);
    return { pair, master: pair.master() };
  }

  /** `/dev/pts/N`'s pair (ENOENT when there is none). */
  get(index: number): PtyPair {
    const pair = this.pairs.get(index);
    if (!pair) throw new KernelError('ENOENT');
    return pair;
  }

  /** The numbers in use (what `/dev/pts` lists). */
  numbers(): number[] {
    return [...this.pairs.keys()].sort((a, b) => a - b);
  }
}

/** `/dev/pts/N`'s number, or undefined for any other path. */
export function ptsNumber(path: string): number | undefined {
  const m = /^\/dev\/pts\/(\d+)$/.exec(path);
  return m ? Number(m[1]) : undefined;
}

/** The pseudo-terminal syscalls (`/dev/ptmx`, `/dev/pts/N` and their ioctls). */
export type PtySyscall =
  | { op: 'pty-open' }
  | { op: 'pty-slave-open'; n: number; noctty: boolean }
  | { op: 'pty-number'; fd: number }
  | { op: 'pty-lock'; fd: number; lock: boolean }
  | { op: 'pty-ctty'; fd: number }
  | { op: 'pty-packet'; fd: number; on: boolean }
  | { op: 'pty-list' }
  | { op: 'pty-winsz-set'; fd: number; rows: number; cols: number };

export const PTY_OPS: readonly PtySyscall['op'][] = [
  'pty-open',
  'pty-slave-open',
  'pty-number',
  'pty-lock',
  'pty-ctty',
  'pty-packet',
  'pty-list',
  'pty-winsz-set',
];

export interface PtyContext {
  pid: number;
  fds: FdTable;
  ptys?: PtyTable;
  jobs?: JobTable;
}

/** A pseudo-terminal's master open on `fd` (ENOTTY for anything else). */
function masterOf(ctx: PtyContext, fd: number): PtyPair {
  const pair = ctx.fds.get(fd).file.pty;
  if (!pair) throw new KernelError('ENOTTY');
  return pair;
}

/** A terminal on `fd`: a terminal itself, or the slave of the master it is. */
function terminalOf(ctx: PtyContext, fd: number): KernelTty {
  const file = ctx.fds.get(fd).file;
  const tty = file.tty ?? file.pty?.slave;
  if (!tty) throw new KernelError('ENOTTY');
  return tty;
}

const json = (value: unknown): SyncFsResult => ({ ok: true, kind: 'json', json: value });
const done: SyncFsResult = { ok: true, kind: 'void' };

export function ptySyscall(req: PtySyscall, ctx: PtyContext): SyncFsResult {
  switch (req.op) {
    case 'pty-open': {
      if (!ctx.ptys) throw new KernelError('ENOENT');
      return json(ctx.fds.install(ctx.ptys.open().master, 3));
    }
    case 'pty-slave-open': {
      if (!ctx.ptys) throw new KernelError('ENOENT');
      const pair = ctx.ptys.get(req.n);
      const fd = ctx.fds.install(pair.openSlave(), 3);
      // A session leader without a controlling terminal takes it (Linux, without O_NOCTTY).
      if (!req.noctty) ctx.jobs?.acquireTerminal(ctx.pid, pair.slave);
      return json(fd);
    }
    case 'pty-number':
      return json(masterOf(ctx, req.fd).index);
    case 'pty-lock':
      masterOf(ctx, req.fd).locked = req.lock;
      return done;
    case 'pty-ctty': {
      const tty = terminalOf(ctx, req.fd);
      // A session leader asking again for the terminal it has: nothing to do (Linux answers 0).
      const leader = ctx.jobs?.getsid(ctx.pid, 0) === ctx.pid;
      if (leader && ctx.jobs?.controllingTerminal(ctx.pid) === tty) return done;
      if (!ctx.jobs?.acquireTerminal(ctx.pid, tty)) throw new KernelError('EPERM');
      return done;
    }
    case 'pty-list':
      return json(ctx.ptys?.numbers() ?? []);
    case 'pty-packet':
      masterOf(ctx, req.fd).packet = req.on;
      return done;
    case 'pty-winsz-set':
      terminalOf(ctx, req.fd).resize(req.cols, req.rows);
      return done;
  }
}
