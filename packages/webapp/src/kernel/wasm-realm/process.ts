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

      contents?: Uint8Array;

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

export function isWasmSyscall(req: object): req is WasmSyscall {
  const op = (req as { op?: unknown }).op;
  return typeof op === 'string' && SYSCALL_OPS.has(op);
}

const MAX_READ = 1024 * 1024;

export interface WasmProcessOptions {
  spawner?: ChildSpawner;

  forker?: ChildForker;

  fs?: VfsFileFs;

  kill?: (pid: number, sig: number) => boolean;

  onPending?: (sig: number) => void;

  hasPending?: () => boolean;
}

export type SignalOutcome = DefaultAction | 'deliver' | 'forward';

export class WasmProcess {
  private exited = false;
  private readonly children: ChildTable;

  private caught = 0;
  private ignored = 0;

  private interrupt = new AbortController();

  private execChild: number | undefined;

  constructor(
    readonly pid: number,
    readonly fds: FdTable,
    private readonly options: WasmProcessOptions = {}
  ) {
    this.children = new ChildTable(fds, options.spawner, options.forker);
    this.children.onChildExit = () => this.signal(SIG.CHLD);
  }

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

  private blockingSignal(): AbortSignal {
    if (this.options.hasPending?.()) throw new KernelError('EINTR');
    return this.interrupt.signal;
  }

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

        const signal = pollFile(file).writable
          ? this.options.hasPending?.()
            ? AbortSignal.abort()
            : this.interrupt.signal
          : this.blockingSignal();
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

  async exit(): Promise<void> {
    if (this.exited) return;
    this.exited = true;
    await this.fds.closeAll();
  }
}
