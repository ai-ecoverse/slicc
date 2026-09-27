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
import { type VfsFileFs, vfsFile } from './vfs-file.js';

/** The syscalls of a wasm-realm process (the request bodies on the SAB wire). */
export type WasmSyscall =
  | { op: 'fd-read'; fd: number; max: number }
  | { op: 'fd-write'; fd: number; body: Uint8Array }
  | { op: 'fd-close'; fd: number }
  | { op: 'fd-pipe' }
  | { op: 'fd-poll'; fd: number }
  | { op: 'fd-open-vfs'; path: string; flags: number; position: number }
  | { op: 'fd-seek'; fd: number; offset: number; whence: number }
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
  | { op: 'proc-fork'; state: ForkState };

const SYSCALL_OPS: ReadonlySet<string> = new Set([
  'fd-read',
  'fd-write',
  'fd-close',
  'fd-pipe',
  'fd-poll',
  'fd-open-vfs',
  'fd-seek',
  'proc-spawn',
  'proc-wait',
  'proc-captured',
  'proc-fork',
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
}

export class WasmProcess {
  private exited = false;
  private readonly children: ChildTable;

  constructor(
    readonly pid: number,
    readonly fds: FdTable,
    private readonly options: WasmProcessOptions = {}
  ) {
    this.children = new ChildTable(fds, options.spawner, options.forker);
  }

  async syscall(req: WasmSyscall): Promise<SyncFsResult> {
    try {
      switch (req.op) {
        case 'fd-read': {
          const file = this.fds.get(req.fd).file;
          if (!file.read) throw new KernelError('EBADF');
          const max = Math.max(0, Math.min(req.max, MAX_READ));
          return { ok: true, kind: 'bytes', bytes: await file.read(max) };
        }
        case 'fd-write': {
          const file = this.fds.get(req.fd).file;
          if (!file.write) throw new KernelError('EBADF');
          return { ok: true, kind: 'json', json: await file.write(req.body) };
        }
        case 'fd-close':
          this.fds.close(req.fd);
          return { ok: true, kind: 'void' };
        case 'fd-pipe': {
          const pipe = openPipe();
          const read = this.fds.install(pipe.read, 3);
          let write: number;
          try {
            write = this.fds.install(pipe.write, 3);
          } catch (e) {
            this.fds.close(read);
            throw e;
          }
          return { ok: true, kind: 'json', json: [read, write] };
        }
        case 'fd-poll':
          return { ok: true, kind: 'json', json: pollFile(this.fds.get(req.fd).file) };
        case 'fd-open-vfs': {
          if (!this.options.fs) throw new SpawnError('ENOSYS');
          const file = vfsFile(this.options.fs, req);
          return { ok: true, kind: 'json', json: this.fds.install(file, 3) };
        }
        case 'fd-seek': {
          const file = this.fds.get(req.fd).file;
          if (!file.seek) throw new KernelError('ESPIPE');
          return { ok: true, kind: 'json', json: await file.seek(req.offset, req.whence) };
        }
        case 'proc-fork':
          return { ok: true, kind: 'json', json: await this.children.fork(req.state) };
        case 'proc-spawn': {
          const { file, argv, env, cwd, stdio } = req;
          const pid = await this.children.spawn({ file, argv, env, cwd }, stdio);
          return { ok: true, kind: 'json', json: pid };
        }
        case 'proc-wait':
          return { ok: true, kind: 'json', json: await this.children.wait(req.pid, req.nohang) };
        case 'proc-captured':
          return { ok: true, kind: 'bytes', bytes: this.children.captured(req.pid, req.slot) };
      }
    } catch (e) {
      if (e instanceof KernelError || e instanceof SpawnError) {
        return { ok: false, errno: e.code, message: e.code };
      }
      throw e;
    }
  }

  /** The process is gone (exit, crash, SIGKILL): release its descriptors once. */
  exit(): void {
    if (this.exited) return;
    this.exited = true;
    this.fds.closeAll();
  }
}
