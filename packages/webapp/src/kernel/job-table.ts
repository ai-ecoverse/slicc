/**
 * Shared table of long-running jobs so a future `jobs` / `fg` / `bg`
 * (#2846) can list detached bash runs and `jshd` units together.
 *
 * ProcessManager remains the pid authority (`ps` / `kill`). This table
 * is the named-job overlay: a bash job id (`bg-N`) or a jshd unit name
 * maps onto the live pid and a small status snapshot.
 */

export type JobKind = 'bash' | 'jshd';

export type JobStatus = 'running' | 'stopped' | 'errored' | 'starting';

export interface JobRecord {
  id: string;
  kind: JobKind;
  pid: number | null;
  argv: readonly string[];
  status: JobStatus;
  startedAt: number;
  restarts: number;
}

export class JobTable {
  private readonly jobs = new Map<string, JobRecord>();

  upsert(record: JobRecord): void {
    this.jobs.set(record.id, { ...record, argv: [...record.argv] });
  }

  get(id: string): JobRecord | undefined {
    const record = this.jobs.get(id);
    return record ? { ...record, argv: [...record.argv] } : undefined;
  }

  remove(id: string): void {
    this.jobs.delete(id);
  }

  list(): JobRecord[] {
    return [...this.jobs.values()].map((record) => ({ ...record, argv: [...record.argv] }));
  }

  clear(): void {
    this.jobs.clear();
  }
}

/** Session-wide table published for shell-script callers, like `__slicc_pm`. */
export const kernelJobTable = new JobTable();
