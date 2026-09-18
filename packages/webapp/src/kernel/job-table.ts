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

export const kernelJobTable = new JobTable();
