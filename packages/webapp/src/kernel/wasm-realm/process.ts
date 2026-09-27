/**
 * `process.ts` — a wasm-realm process as the kernel sees it (#3530): its pid
 * and fd table, and the syscalls its worker sends over the SAB bridge.
 *
 * Results use the sync bridge's {@link SyncFsResult} shape, so the existing
 * Atomics/SAB transport and responder carry them unchanged: a read is
 * `bytes` (empty at end of file), a write is `json` (the byte count), a close
 * is `void`, a failure is an errno. A read on an empty pipe resolves only
 * when data arrives: the responder answers late, the worker stays parked in
 * `Atomics.wait`, and nothing blocks the kernel.
 */
import type { SyncFsResult } from '../realm/sync-fs-wire.js';
import { type FdTable, KernelError } from './fd-table.js';

/** The syscalls of a wasm-realm process (the request bodies on the SAB wire). */
export type WasmSyscall =
  | { op: 'fd-read'; fd: number; max: number }
  | { op: 'fd-write'; fd: number; body: Uint8Array }
  | { op: 'fd-close'; fd: number };

const SYSCALL_OPS: ReadonlySet<string> = new Set(['fd-read', 'fd-write', 'fd-close']);

/** Whether a SAB request is a process syscall (else it is a sync-fs / exec op). */
export function isWasmSyscall(req: object): req is WasmSyscall {
  const op = (req as { op?: unknown }).op;
  return typeof op === 'string' && SYSCALL_OPS.has(op);
}

/** Largest read one syscall serves: the SAB bridge drains bigger payloads in rounds anyway. */
const MAX_READ = 1024 * 1024;

export class WasmProcess {
  private exited = false;

  constructor(
    readonly pid: number,
    readonly fds: FdTable
  ) {}

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
      }
    } catch (e) {
      if (e instanceof KernelError) return { ok: false, errno: e.code, message: e.code };
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
