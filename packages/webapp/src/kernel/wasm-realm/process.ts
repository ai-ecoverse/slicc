import type { SyncFsResult } from '../realm/sync-fs-wire.js';
import { type ChildSpawner, type ChildStdio, ChildTable, SpawnError } from './children.js';
import { type FdTable, KernelError } from './fd-table.js';

export type WasmSyscall =
  | { op: 'fd-read'; fd: number; max: number }
  | { op: 'fd-write'; fd: number; body: Uint8Array }
  | { op: 'fd-close'; fd: number }
  | {
      op: 'proc-spawn';
      file: string;
      argv: string[];
      env: Record<string, string>;
      cwd: string;
      stdio: ChildStdio[];
    }
  | { op: 'proc-wait'; pid: number; nohang: boolean }
  | { op: 'proc-captured'; pid: number; slot: number };

const SYSCALL_OPS: ReadonlySet<string> = new Set([
  'fd-read',
  'fd-write',
  'fd-close',
  'proc-spawn',
  'proc-wait',
  'proc-captured',
]);

export function isWasmSyscall(req: object): req is WasmSyscall {
  const op = (req as { op?: unknown }).op;
  return typeof op === 'string' && SYSCALL_OPS.has(op);
}

const MAX_READ = 1024 * 1024;

export class WasmProcess {
  private exited = false;
  private readonly children: ChildTable;

  constructor(
    readonly pid: number,
    readonly fds: FdTable,
    spawner?: ChildSpawner
  ) {
    this.children = new ChildTable(fds, spawner);
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

  exit(): void {
    if (this.exited) return;
    this.exited = true;
    this.fds.closeAll();
  }
}
