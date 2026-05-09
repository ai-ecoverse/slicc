/**
 * `ProcMountBackend` — read-only `procfs`-shaped view of the kernel
 * `ProcessManager`. Phase 5.
 *
 * Mounted at `/proc` by `createKernelHost` via the new
 * `mountInternal` API (Phase 5.2): not persisted, not visible in
 * `mount list`, not visible to `RestrictedFS` (so scoops can't see
 * each other's processes). Layout:
 *
 *   /proc/                  one directory per live pid + `1` for the
 *                           kernel-host anchor
 *   /proc/<pid>/status      human-readable summary
 *   /proc/<pid>/cmdline     null-separated argv (POSIX-style)
 *   /proc/<pid>/cwd         working directory as plain text
 *   /proc/<pid>/stat        single-line procfs-style record
 *
 * Deliberate divergences from POSIX:
 *   - No `/proc/self`: requires `currentPid()` tracking, which
 *     needs `AsyncLocalStorage` or explicit per-call threading the
 *     kernel doesn't have today. Reads of `/proc/self/*` return
 *     ENOENT for now. (Documented; Phase 6+ may add it.)
 *   - No `environ`, no `fd/`, no `task/`. The full Linux procfs
 *     surface is out of scope; just what `ps` and `kill` need to
 *     drive their views.
 *   - All writes throw `EACCES` ('read-only filesystem') —
 *     `FsErrorCode` doesn't have `EROFS`, so `EACCES` with the
 *     read-only message is the closest match. The mount-layer
 *     callers translate this into the right exit code for `tee`,
 *     `>`, etc.
 *   - `pid 1` is synthesized as the kernel-host anchor: the
 *     parent of any orphan process. It has no `Process` record;
 *     reads of `/proc/1/*` return a fixed "kernel-host" payload.
 *     `ps`'s tree mode (Phase 4) treats untracked ppids as
 *     orphans, which Phase 5 keeps consistent.
 */

import { FsError } from '../fs/types.js';
import type {
  MountBackend,
  MountDirEntry,
  MountStat,
  MountDescription,
  RefreshReport,
} from '../fs/mount/backend.js';
import type { Process, ProcessManager } from './process-manager.js';

const KERNEL_PID = 1;

export interface ProcMountBackendOptions {
  mountId?: string;
}

export class ProcMountBackend implements MountBackend {
  readonly kind = 'proc' as const;
  readonly source = undefined;
  readonly profile = undefined;
  readonly mountId: string;
  private readonly pm: ProcessManager;
  private closed = false;

  constructor(pm: ProcessManager, opts: ProcMountBackendOptions = {}) {
    this.pm = pm;
    this.mountId = opts.mountId ?? `proc-${Date.now().toString(36)}`;
  }

  async readDir(path: string): Promise<MountDirEntry[]> {
    this.assertOpen(path);
    const segments = splitPath(path);
    if (segments.length === 0) {
      // /proc — one directory per live pid + kernel anchor.
      const procs = this.pm.list();
      const entries: MountDirEntry[] = procs.map((p) => ({
        name: String(p.pid),
        kind: 'directory' as const,
      }));
      // Always include the kernel-host anchor so `cat /proc/1/status`
      // works even when there are no other processes.
      if (!procs.some((p) => p.pid === KERNEL_PID)) {
        entries.push({ name: String(KERNEL_PID), kind: 'directory' });
      }
      return entries.sort((a, b) => Number(a.name) - Number(b.name));
    }
    if (segments.length === 1) {
      // /proc/<pid> — fixed file set.
      const pid = parsePid(segments[0]);
      if (pid === null) throw new FsError('ENOENT', 'no such file or directory', path);
      if (!this.pidExists(pid)) throw new FsError('ENOENT', 'no such file or directory', path);
      return PROC_FILES.map((name) => ({
        name,
        kind: 'file' as const,
        size: this.fileSize(pid, name),
        lastModified: this.fileMtime(pid),
      }));
    }
    // /proc/<pid>/<something> — files have no children; treating any
    // deeper readDir as ENOTDIR matches Linux procfs.
    throw new FsError('ENOTDIR', 'not a directory', path);
  }

  async readFile(path: string): Promise<Uint8Array> {
    this.assertOpen(path);
    const segments = splitPath(path);
    if (segments.length !== 2) {
      throw new FsError('EISDIR', 'is a directory', path);
    }
    const pid = parsePid(segments[0]);
    if (pid === null) throw new FsError('ENOENT', 'no such file or directory', path);
    if (!this.pidExists(pid)) throw new FsError('ENOENT', 'no such file or directory', path);
    const name = segments[1];
    if (!PROC_FILES.includes(name as ProcFile)) {
      throw new FsError('ENOENT', 'no such file or directory', path);
    }
    const text = this.renderProcFile(pid, name as ProcFile);
    return new TextEncoder().encode(text);
  }

  async writeFile(path: string): Promise<void> {
    throw new FsError('EACCES', 'read-only filesystem', path);
  }

  async stat(path: string): Promise<MountStat> {
    this.assertOpen(path);
    const segments = splitPath(path);
    if (segments.length === 0) {
      return { kind: 'directory', size: 0, mtime: 0 };
    }
    if (segments.length === 1) {
      const pid = parsePid(segments[0]);
      if (pid === null) throw new FsError('ENOENT', 'no such file or directory', path);
      if (!this.pidExists(pid)) throw new FsError('ENOENT', 'no such file or directory', path);
      return { kind: 'directory', size: 0, mtime: this.fileMtime(pid) };
    }
    if (segments.length === 2) {
      const pid = parsePid(segments[0]);
      if (pid === null) throw new FsError('ENOENT', 'no such file or directory', path);
      if (!this.pidExists(pid)) throw new FsError('ENOENT', 'no such file or directory', path);
      const name = segments[1];
      if (!PROC_FILES.includes(name as ProcFile)) {
        throw new FsError('ENOENT', 'no such file or directory', path);
      }
      return {
        kind: 'file',
        size: this.fileSize(pid, name),
        mtime: this.fileMtime(pid),
      };
    }
    throw new FsError('ENOENT', 'no such file or directory', path);
  }

  async mkdir(path: string): Promise<void> {
    throw new FsError('EACCES', 'read-only filesystem', path);
  }

  async remove(path: string): Promise<void> {
    throw new FsError('EACCES', 'read-only filesystem', path);
  }

  /** No-op: `/proc` is generated on every read. */
  async refresh(): Promise<RefreshReport> {
    return { added: [], removed: [], changed: [], unchanged: 0, errors: [] };
  }

  describe(): MountDescription {
    return { displayName: '/proc', extra: 'kernel processes (read-only)' };
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private assertOpen(path: string): void {
    if (this.closed) throw new FsError('EBADF', 'mount closed', path);
  }

  private pidExists(pid: number): boolean {
    if (pid === KERNEL_PID) return true;
    return this.pm.get(pid) !== null;
  }

  private fileSize(pid: number, name: string): number {
    return this.renderProcFile(pid, name as ProcFile).length;
  }

  private fileMtime(pid: number): number {
    if (pid === KERNEL_PID) return 0;
    const proc = this.pm.get(pid);
    if (!proc) return 0;
    return proc.finishedAt ?? proc.startedAt;
  }

  private renderProcFile(pid: number, name: ProcFile): string {
    if (pid === KERNEL_PID) {
      return renderKernelHost(name);
    }
    const proc = this.pm.get(pid)!;
    switch (name) {
      case 'status':
        return renderStatus(proc);
      case 'cmdline':
        return renderCmdline(proc);
      case 'cwd':
        return renderCwd(proc);
      case 'stat':
        return renderStat(proc);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROC_FILES = ['status', 'cmdline', 'cwd', 'stat'] as const;
type ProcFile = (typeof PROC_FILES)[number];

function splitPath(path: string): string[] {
  return path.replace(/^\/+/, '').replace(/\/+$/, '').split('/').filter(Boolean);
}

function parsePid(segment: string): number | null {
  const n = Number.parseInt(segment, 10);
  if (!Number.isFinite(n) || String(n) !== segment) return null;
  return n;
}

function renderStatus(proc: Process): string {
  const lines = [
    `Name:\t${proc.kind}`,
    `Pid:\t${proc.pid}`,
    `PPid:\t${proc.ppid}`,
    `State:\t${stateLetter(proc.status)} (${proc.status})`,
    `Owner:\t${ownerLabel(proc)}`,
    `StartedAt:\t${new Date(proc.startedAt).toISOString()}`,
  ];
  if (proc.finishedAt !== null) {
    lines.push(`FinishedAt:\t${new Date(proc.finishedAt).toISOString()}`);
  }
  if (proc.terminatedBy !== null) {
    lines.push(`TerminatedBy:\t${proc.terminatedBy}`);
  }
  if (proc.exitCode !== null) {
    lines.push(`ExitCode:\t${proc.exitCode}`);
  }
  lines.push(`Cmdline:\t${proc.argv.join(' ')}`);
  return lines.join('\n') + '\n';
}

function renderCmdline(proc: Process): string {
  // POSIX procfs: argv joined by NUL bytes, trailing NUL.
  return proc.argv.join('\0') + '\0';
}

function renderCwd(proc: Process): string {
  return proc.cwd + '\n';
}

function renderStat(proc: Process): string {
  // Single-line, space-separated record. We don't try to mimic Linux's
  // 50+ fields — just pid, kind, state, ppid, exit, started, finished.
  return (
    [
      proc.pid,
      `(${proc.kind})`,
      stateLetter(proc.status),
      proc.ppid,
      proc.exitCode ?? '-',
      proc.startedAt,
      proc.finishedAt ?? '-',
    ].join(' ') + '\n'
  );
}

function stateLetter(status: Process['status']): string {
  switch (status) {
    case 'running':
      return 'R';
    case 'pending':
      return 'S';
    case 'exited':
      return 'Z';
    case 'killed':
      return 'K';
  }
}

function ownerLabel(proc: Process): string {
  if (proc.owner.kind === 'cone') return 'cone';
  if (proc.owner.kind === 'system') return 'system';
  return proc.owner.scoopJid ? `scoop/${proc.owner.scoopJid}` : 'scoop';
}

function renderKernelHost(name: ProcFile): string {
  switch (name) {
    case 'status':
      return (
        [
          'Name:\tkernel-host',
          `Pid:\t${KERNEL_PID}`,
          `PPid:\t0`,
          'State:\tR (running)',
          'Owner:\tsystem',
        ].join('\n') + '\n'
      );
    case 'cmdline':
      return 'kernel-host\0';
    case 'cwd':
      return '/\n';
    case 'stat':
      return `${KERNEL_PID} (kernel-host) R 0 - 0 -\n`;
  }
}
