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
  | { op: 'proc-fork'; state: ForkState };

const SYSCALL_OPS: ReadonlySet<string> = new Set([
  'fd-read',
  'fd-write',
  'fd-close',
  'fd-pipe',
  'fd-poll',
  'fd-open-vfs',
  'fd-seek',
  'fd-flush',
  'proc-spawn',
  'proc-wait',
  'proc-captured',
  'proc-fork',
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

  async exit(): Promise<void> {
    if (this.exited) return;
    this.exited = true;
    await this.fds.closeAll();
  }
}
