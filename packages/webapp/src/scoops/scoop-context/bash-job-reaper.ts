import { createLogger } from '../../core/index.js';
import type { ProcessManager, ProcessOwner } from '../../kernel/process-manager.js';
import type { BashJobProcess } from '../../tools/types.js';

const log = createLogger('scoop-context');

export interface BashJobReaperDeps {
  processManager: ProcessManager | null;

  cwd: string;
  owner: ProcessOwner;

  getTurnPid: () => number | undefined;

  folder: string;
}

export class BashJobReaper {
  private readonly livePids = new Set<number>();

  constructor(private readonly deps: BashJobReaperDeps) {}

  spawn(command: string): BashJobProcess | null {
    const pm = this.deps.processManager;
    if (!pm) return null;
    const forget = (pid: number) => {
      this.livePids.delete(pid);
    };
    const proc = pm.spawn({
      kind: 'shell',
      argv: ['bash', '-c', command],
      cwd: this.deps.cwd,
      owner: this.deps.owner,
      ppid: this.deps.getTurnPid(),
    });
    this.livePids.add(proc.pid);
    return {
      pid: proc.pid,
      signal: proc.abort.signal,
      kill: () => {
        forget(proc.pid);
        pm.signal(proc.pid, 'SIGKILL');
      },
      exit: (exitCode) => {
        forget(proc.pid);
        pm.exit(proc.pid, exitCode);
      },
    };
  }

  reapAll(): void {
    const pm = this.deps.processManager;
    if (!pm || this.livePids.size === 0) return;
    const pids = [...this.livePids];
    this.livePids.clear();
    log.info('Reaping background bash jobs on dispose', {
      folder: this.deps.folder,
      pids,
    });
    for (const pid of pids) pm.signal(pid, 'SIGKILL');
  }
}
