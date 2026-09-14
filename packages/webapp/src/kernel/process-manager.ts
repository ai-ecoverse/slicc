export type ProcessKind = 'scoop-turn' | 'tool' | 'shell' | 'jsh' | 'py' | 'net';

export type ProcessStatus = 'pending' | 'running' | 'exited' | 'killed';

export type Signal = 'SIGINT' | 'SIGTERM' | 'SIGSTOP' | 'SIGCONT' | 'SIGKILL';

export class Gate {
  private paused = false;
  private resumePromise: Promise<void> | null = null;
  private resumeResolve: (() => void) | null = null;
  private released = false;

  pause(): void {
    if (this.released) return;
    if (this.paused) return;
    this.paused = true;
    this.resumePromise = new Promise<void>((resolve) => {
      this.resumeResolve = resolve;
    });
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    const r = this.resumeResolve;
    this.resumePromise = null;
    this.resumeResolve = null;
    r?.();
  }

  wait(): Promise<void> {
    if (!this.paused || this.released) return Promise.resolve();
    return this.resumePromise!;
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.paused = false;
    const r = this.resumeResolve;
    this.resumePromise = null;
    this.resumeResolve = null;
    r?.();
  }

  isPaused(): boolean {
    return this.paused;
  }
}

export interface ProcessOwner {
  kind: 'cone' | 'scoop' | 'system';

  scoopJid?: string;
}

export interface SpawnOptions {
  kind: ProcessKind;
  argv: readonly string[];
  cwd?: string;
  env?: Record<string, string>;
  owner: ProcessOwner;

  ppid?: number;

  adoptAbort?: AbortController;
}

export interface Process {
  readonly pid: number;
  readonly ppid: number;
  readonly kind: ProcessKind;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly owner: ProcessOwner;
  readonly abort: AbortController;

  readonly gate: Gate;
  readonly startedAt: number;
  status: ProcessStatus;
  exitCode: number | null;

  terminatedBy: Signal | null;
  finishedAt: number | null;
}

export type ProcessEvent = 'spawn' | 'exit';

export interface ProcessTableStats {
  live: number;
  retained: number;
  terminated: number;
  spawned: number;
}

export type ProcessEventListener = (proc: Process) => void;

export type ProcessSignalListener = (proc: Process, sig: Signal) => void;

const PID_FLOOR = 1024;
const PID_CEIL = 0xffffffff;

const TERMINATED_RETENTION = 128;

const SIGNAL_EXIT_CODE: Record<Signal, number> = {
  SIGINT: 130,
  SIGTERM: 143,
  SIGKILL: 137,
  SIGSTOP: 128 + 19,
  SIGCONT: 128 + 18,
};

export class ProcessManager {
  private readonly processes = new Map<number, Process>();
  private nextPid = PID_FLOOR;
  private readonly listeners: Record<ProcessEvent, Set<ProcessEventListener>> = {
    spawn: new Set(),
    exit: new Set(),
  };
  private readonly signalListeners = new Set<ProcessSignalListener>();

  private readonly terminatedPids: number[] = [];
  private spawnedTotal = 0;
  private terminatedTotal = 0;

  spawn(options: SpawnOptions): Process {
    const pid = this.allocatePid();
    const abort = options.adoptAbort ?? new AbortController();
    const proc: Process = {
      pid,
      ppid: options.ppid ?? 1,
      kind: options.kind,
      argv: options.argv.slice(),
      cwd: options.cwd ?? '/',
      env: { ...(options.env ?? {}) },
      owner: { ...options.owner },
      abort,
      gate: new Gate(),
      startedAt: Date.now(),
      status: 'running',
      exitCode: null,
      terminatedBy: null,
      finishedAt: null,
    };
    this.processes.set(pid, proc);
    this.spawnedTotal++;
    this.fire('spawn', proc);
    return proc;
  }

  exit(pid: number, exitCode: number | null): void {
    const proc = this.processes.get(pid);
    if (!proc) return;
    if (proc.status === 'exited' || proc.status === 'killed') return;
    proc.finishedAt = Date.now();
    if (exitCode !== null) {
      proc.exitCode = exitCode;
      proc.status = proc.terminatedBy ? 'killed' : 'exited';
    } else if (proc.terminatedBy) {
      proc.exitCode = SIGNAL_EXIT_CODE[proc.terminatedBy];
      proc.status = 'killed';
    } else {
      proc.exitCode = 0;
      proc.status = 'exited';
    }

    proc.gate.release();
    this.terminatedTotal++;

    this.fire('exit', proc);
    this.retire(proc.pid);
  }

  signal(pid: number, sig: Signal): boolean {
    const proc = this.processes.get(pid);
    if (!proc) return false;
    if (proc.status === 'exited' || proc.status === 'killed') return false;

    const descendants = this.collectLiveDescendants(pid);
    const delivered = this.deliverSignal(proc, sig);
    for (const child of descendants) {
      this.deliverSignal(child, sig);
    }
    return delivered;
  }

  private deliverSignal(proc: Process, sig: Signal): boolean {
    if (proc.status === 'exited' || proc.status === 'killed') return false;
    if (sig === 'SIGSTOP') {
      proc.gate.pause();
      this.fireSignal(proc, sig);
      return true;
    }
    if (sig === 'SIGCONT') {
      proc.gate.resume();
      this.fireSignal(proc, sig);
      return true;
    }
    if (sig === 'SIGKILL') {
      proc.terminatedBy = 'SIGKILL';
    } else if (proc.terminatedBy === null) {
      proc.terminatedBy = sig;
    }
    if (!proc.abort.signal.aborted) {
      proc.abort.abort();
    }

    proc.gate.release();
    this.fireSignal(proc, sig);
    return true;
  }

  private collectLiveDescendants(rootPid: number): Process[] {
    const childrenByPpid = new Map<number, Process[]>();
    for (const p of this.processes.values()) {
      if (p.pid === p.ppid) continue;
      if (p.status === 'exited' || p.status === 'killed') continue;
      const siblings = childrenByPpid.get(p.ppid);
      if (siblings) siblings.push(p);
      else childrenByPpid.set(p.ppid, [p]);
    }
    const result: Process[] = [];
    const visited = new Set<number>([rootPid]);
    const queue: number[] = [rootPid];
    while (queue.length > 0) {
      const current = queue.shift() as number;
      const children = childrenByPpid.get(current);
      if (!children) continue;
      for (const child of children) {
        if (visited.has(child.pid)) continue;
        visited.add(child.pid);
        result.push(child);
        queue.push(child.pid);
      }
    }
    return result;
  }

  list(): Process[] {
    return Array.from(this.processes.values());
  }

  listLive(): Process[] {
    return this.list().filter((p) => p.status === 'pending' || p.status === 'running');
  }

  stats(): ProcessTableStats {
    const live = this.listLive().length;
    return {
      live,
      retained: this.processes.size,
      terminated: this.terminatedTotal,
      spawned: this.spawnedTotal,
    };
  }

  get(pid: number): Process | null {
    return this.processes.get(pid) ?? null;
  }

  wait(pid: number): Promise<Process> {
    const proc = this.processes.get(pid);
    if (!proc) return Promise.reject(new Error(`pm: no such process: ${pid}`));
    if (proc.status === 'exited' || proc.status === 'killed') {
      return Promise.resolve(proc);
    }
    return new Promise<Process>((resolve) => {
      const handler = (p: Process): void => {
        if (p.pid !== pid) return;
        this.listeners.exit.delete(handler);
        resolve(p);
      };
      this.listeners.exit.add(handler);
    });
  }

  on(event: ProcessEvent, listener: ProcessEventListener): () => void {
    this.listeners[event].add(listener);
    return () => {
      this.listeners[event].delete(listener);
    };
  }

  onSignal(listener: ProcessSignalListener): () => void {
    this.signalListeners.add(listener);
    return () => {
      this.signalListeners.delete(listener);
    };
  }

  private retire(pid: number): void {
    this.terminatedPids.push(pid);
    while (this.terminatedPids.length > TERMINATED_RETENTION) {
      const oldest = this.terminatedPids.shift() as number;
      this.processes.delete(oldest);
    }
  }

  private allocatePid(): number {
    const start = this.nextPid;
    const ceiling = this.processes.size + 1;
    let pid = start;
    let probes = 0;
    while (probes <= ceiling) {
      if (!this.processes.has(pid)) {
        this.nextPid = pid + 1 > PID_CEIL ? PID_FLOOR : pid + 1;
        return pid;
      }
      pid = pid + 1 > PID_CEIL ? PID_FLOOR : pid + 1;
      probes++;
      if (pid === start) {
        throw new Error('pm: pid space exhausted');
      }
    }
    throw new Error(
      `pm: pid allocation gave up after ${probes} probes (table size=${this.processes.size}); ` +
        'the process table is likely corrupt'
    );
  }

  private fire(event: ProcessEvent, proc: Process): void {
    const listeners = Array.from(this.listeners[event]);
    for (const l of listeners) {
      try {
        l(proc);
      } catch (err) {
        console.warn('[pm] listener error', err);
      }
    }
  }

  private fireSignal(proc: Process, sig: Signal): void {
    const listeners = Array.from(this.signalListeners);
    for (const l of listeners) {
      try {
        l(proc, sig);
      } catch (err) {
        console.warn('[pm] signal listener error', err);
      }
    }
  }
}

export async function runAsProcess<T>(
  pm: ProcessManager,
  options: SpawnOptions,
  block: (proc: Process) => Promise<T>
): Promise<T> {
  const proc = pm.spawn(options);
  try {
    const result = await block(proc);
    pm.exit(proc.pid, 0);
    return result;
  } catch (err) {
    if (proc.abort.signal.aborted) {
      pm.exit(proc.pid, null);
    } else {
      pm.exit(proc.pid, 1);
    }
    throw err;
  }
}
