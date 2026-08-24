/**
 * Detached `bash` job bookkeeping.
 *
 * Owns: the set of still-running background job pids a unit spawned, the
 * kernel process each job runs as, and the SIGKILL fan-out on teardown.
 *
 * Changes when the process model changes (how a job parents to its turn, what
 * a teardown has to reap). It is deliberately separate from the turn loop: a
 * detached job OUTLIVES the turn that spawned it, so its lifetime is the
 * unit's, not the run's (#1166).
 */

import { createLogger } from '../../core/index.js';
import type { ProcessManager, ProcessOwner } from '../../kernel/process-manager.js';
import type { BashJobProcess } from '../../tools/types.js';

const log = createLogger('scoop-context');

export interface BashJobReaperDeps {
  processManager: ProcessManager | null;
  /** Working directory a job's process record reports. */
  cwd: string;
  owner: ProcessOwner;
  /** Pid of the in-flight turn, or `undefined` between turns. */
  getTurnPid: () => number | undefined;
  /** Unit folder, for log correlation only. */
  folder: string;
}

export class BashJobReaper {
  /**
   * Pids of `bash` jobs still running, so `dispose()` can reap them.
   *
   * Signalling the turn pid is not enough: a detached job outlives its turn on
   * purpose (that is how its completion lick still arrives), and the turn record
   * is gone by then — so a later `drop_scoop`, or the automatic teardown of a
   * one-shot `agent` scoop, would leave the command running against a scoop
   * directory that is being deleted. Entries are removed as each job exits or is
   * killed, so this holds only genuinely live pids.
   */
  private readonly livePids = new Set<number>();

  constructor(private readonly deps: BashJobReaperDeps) {}

  /**
   * Register one `bash` invocation as a `kind:'shell'` process so it is a real
   * pid: `ps` lists it, `kill <pid>` reaches it, and a SIGKILL fans out over the
   * ppid tree to any realm-backed descendant (`node` / `python3` / `.jsh`), which
   * `worker.terminate()`s uncatchably. The bash tool passes the pid back into
   * `AlmostBashShell.executeCommand` so those descendants parent HERE instead of
   * to the turn.
   *
   * Parented to the turn pid deliberately: `pm.exit()` (normal turn end) does not
   * cascade, so a detached job survives to deliver its lick, while an explicit
   * cancel / `stop()` / `drop_scoop` — all of which SIGNAL the turn pid — fans
   * out and reaps the whole tree (#1166).
   */
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

  /**
   * SIGKILL every still-running `bash` job on teardown.
   *
   * A detached job survives its own turn deliberately, so by dispose time its
   * parent turn record is usually gone and the turn-pid signal above cannot
   * reach it. SIGKILL rather than SIGTERM because the point is that the command
   * stops: the manager fans it out to the job's realm descendants, which
   * `worker.terminate()` uncatchably. Any pending completion lick is moot — for
   * `drop_scoop` and one-shot `agent` teardown the scoop directory the output
   * would be written to is being removed with it.
   */
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
