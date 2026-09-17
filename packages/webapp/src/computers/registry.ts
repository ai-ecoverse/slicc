/**
 * Kernel-worker computer registry. One ProcessManager process per computer
 * (kind `'computer'`), `change` events, `kill` closes the backend.
 *
 * Constructed once via {@link installComputerRegistry} the same way
 * `installJshdSupervisor` pins kernel-owned deps. Adapters import this
 * module lazily so it stays out of the worker first-load graph.
 */

import type { ComputerDescriptor, ComputerFrame, ComputerLastShot } from '@slicc/shared-ts';
import type { ProcessManager } from '../kernel/process-manager.js';
import type { ComputerBackend } from './backend.js';

export type ComputerChangeListener = (computers: ComputerDescriptor[]) => void;

export interface RegisterComputerOptions {
  /** Adopt an existing pid (v86 VM, jshd unit) instead of spawning. */
  pid?: number | null;
  argv?: string[];
  cwd?: string;
}

interface Entry {
  backend: ComputerBackend;
  pid: number | null;
  ownsPid: boolean;
  lastShot?: ComputerLastShot;
  lastFrame: ComputerFrame | null;
  seq: number;
  unsubAbort: (() => void) | null;
}

export class ComputerRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<ComputerChangeListener>();
  private usedId: string | null = null;
  private readonly pm: ProcessManager | null;

  constructor(pm: ProcessManager | null = null) {
    this.pm = pm;
  }

  onChange(listener: ComputerChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(): ComputerDescriptor[] {
    return [...this.entries.values()]
      .map((entry) => this.decorate(entry))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  get(id: string): ComputerBackend | null {
    return this.entries.get(id)?.backend ?? null;
  }

  getEntry(id: string): { backend: ComputerBackend; descriptor: ComputerDescriptor } | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    return { backend: entry.backend, descriptor: this.decorate(entry) };
  }

  lastUsedId(): string | null {
    return this.usedId;
  }

  use(id: string): ComputerDescriptor | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    this.usedId = id;
    return this.decorate(entry);
  }

  rememberShot(id: string, lastShot: ComputerLastShot, frame?: ComputerFrame): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.lastShot = lastShot;
    if (frame) {
      entry.lastFrame = frame;
      entry.seq = frame.seq;
    }
    this.emitChange();
  }

  nextSeq(id: string): number {
    const entry = this.entries.get(id);
    if (!entry) return 1;
    entry.seq += 1;
    return entry.seq;
  }

  lastFrame(id: string): ComputerFrame | null {
    return this.entries.get(id)?.lastFrame ?? null;
  }

  register(backend: ComputerBackend, options: RegisterComputerOptions = {}): ComputerDescriptor {
    const described = backend.describe();
    const id = described.id;
    const existing = this.entries.get(id);
    if (existing) {
      void existing.backend.close().catch(() => {
        /* replaced */
      });
      this.detach(existing);
      this.entries.delete(id);
    }

    let pid = options.pid ?? described.pid ?? null;
    let ownsPid = false;
    if (pid == null && this.pm) {
      const proc = this.pm.spawn({
        kind: 'computer',
        argv: options.argv ?? ['computer', id],
        cwd: options.cwd ?? '/',
        owner: { kind: 'system' },
      });
      pid = proc.pid;
      ownsPid = true;
    }

    const entry: Entry = {
      backend,
      pid,
      ownsPid,
      lastShot: described.lastShot,
      lastFrame: null,
      seq: 0,
      unsubAbort: null,
    };
    if (pid != null && this.pm) {
      const proc = this.pm.get(pid);
      if (proc) {
        const onAbort = (): void => {
          void this.closeFromSignal(id);
        };
        proc.abort.signal.addEventListener('abort', onAbort);
        entry.unsubAbort = () => proc.abort.signal.removeEventListener('abort', onAbort);
      }
    }
    this.entries.set(id, entry);
    this.emitChange();
    return this.decorate(entry);
  }

  async unregister(id: string): Promise<boolean> {
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.entries.delete(id);
    if (this.usedId === id) this.usedId = null;
    this.detach(entry);
    try {
      await entry.backend.close();
    } catch {
      // Best-effort — the adapter may already be gone.
    }
    if (entry.ownsPid && entry.pid != null && this.pm) this.pm.exit(entry.pid, 0);
    this.emitChange();
    return true;
  }

  private async closeFromSignal(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    if (this.usedId === id) this.usedId = null;
    this.detach(entry);
    try {
      await entry.backend.close();
    } catch {
      /* already closing */
    }
    this.emitChange();
  }

  private detach(entry: Entry): void {
    entry.unsubAbort?.();
    entry.unsubAbort = null;
  }

  private decorate(entry: Entry): ComputerDescriptor {
    const d = entry.backend.describe();
    return {
      ...d,
      pid: entry.pid,
      lastShot: entry.lastShot ?? d.lastShot,
    };
  }

  private emitChange(): void {
    const list = this.list();
    for (const listener of [...this.listeners]) {
      try {
        listener(list);
      } catch {
        // Listener faults must not poison the registry.
      }
    }
  }

  resetForTests(): void {
    for (const [id, entry] of [...this.entries]) {
      this.detach(entry);
      void entry.backend.close().catch(() => {
        /* test reset */
      });
      if (entry.ownsPid && entry.pid != null && this.pm) this.pm.exit(entry.pid, 0);
      this.entries.delete(id);
    }
    this.usedId = null;
    this.listeners.clear();
  }
}

let singleton: ComputerRegistry | null = null;

export function installComputerRegistry(pm: ProcessManager | null): ComputerRegistry {
  if (!singleton) singleton = new ComputerRegistry(pm);
  return singleton;
}

export function getComputerRegistry(): ComputerRegistry | null {
  return singleton;
}

export function requireComputerRegistry(): ComputerRegistry {
  if (!singleton) throw new Error('computer registry is not installed');
  return singleton;
}

export function resetComputerRegistryForTests(): void {
  singleton?.resetForTests();
  singleton = null;
}
