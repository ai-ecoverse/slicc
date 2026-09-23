/**
 * Durable record of the `bash` tool's detached jobs, so a job that dies with
 * the kernel worker is reported instead of vanishing (#3441).
 *
 * A detached job lives only in worker memory: its pid, its completion lick,
 * and the promise that would write its final output. When the worker goes
 * down (out of memory, page reload) all of that is gone, and the agent is
 * left waiting for a "Background Command" lick that never comes. The journal
 * writes one small file per detached job and deletes it when the job settles.
 * Any file left over from an EARLIER kernel boot therefore names a job that
 * never finished, and the next boot's sweep reports it.
 */

import type { VirtualFS } from '../fs/index.js';

/** Journal directory, relative to the context's temp dir. */
export const BASH_JOB_JOURNAL_DIR = '.bash-jobs';

/**
 * Identifies this kernel worker's lifetime. A record carrying another id was
 * written by a worker that is gone; records from this boot are still live.
 */
export const KERNEL_BOOT_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** Exit code reported for a job the kernel restart killed (as for SIGKILL). */
export const KERNEL_RESTART_EXIT_CODE = 137;

export interface BashJobRecord {
  bootId: string;
  jobId: string;
  pid?: number;
  command: string;
  outputPath: string;
  startedAt: string;
}

/** Line appended to an orphaned job's output file, and used as its lick preview. */
export function kernelRestartNotice(record: BashJobRecord): string {
  return (
    `--- job ${record.jobId} did not finish: the kernel worker restarted while it was running ` +
    '(for example after running out of memory). Output above may be partial and files it was ' +
    `writing may be incomplete; re-run the command. (exit ${KERNEL_RESTART_EXIT_CODE}) ---\n`
  );
}

type JournalFs = Pick<
  VirtualFS,
  'mkdir' | 'writeFile' | 'appendFile' | 'readDir' | 'readFile' | 'rm'
>;

export interface BashJobJournal {
  /** Record a job that just detached. Never rejects. */
  record(record: Omit<BashJobRecord, 'bootId'>): Promise<void>;
  /** Drop a settled job's record. Never rejects. */
  clear(jobId: string): Promise<void>;
  /**
   * Report every record left by an earlier boot: append the restart notice to
   * its output file, hand it to `report`, then delete it. Resolves with the
   * records reported. Never rejects.
   */
  sweep(report: (record: BashJobRecord, notice: string) => void): Promise<BashJobRecord[]>;
}

function isRecord(value: unknown): value is BashJobRecord {
  const r = value as Partial<BashJobRecord> | null;
  return (
    typeof r === 'object' &&
    r !== null &&
    typeof r.bootId === 'string' &&
    typeof r.jobId === 'string' &&
    typeof r.command === 'string' &&
    typeof r.outputPath === 'string'
  );
}

export function createBashJobJournal(
  fs: JournalFs,
  tempDir: string,
  bootId: string = KERNEL_BOOT_ID,
  onError: (message: string, error: unknown) => void = () => undefined
): BashJobJournal {
  const dir = `${tempDir.replace(/\/+$/, '')}/${BASH_JOB_JOURNAL_DIR}`;
  // The boot id is part of the name: job ids restart at bg-1 on every boot,
  // and a new job must not overwrite the record of an orphan not yet swept.
  const pathFor = (id: string, jobId: string) => `${dir}/${id}.${jobId}.json`;

  const sweepOne = async (
    name: string,
    report: (record: BashJobRecord, notice: string) => void
  ): Promise<BashJobRecord | null> => {
    const path = `${dir}/${name}`;
    let record: unknown;
    try {
      record = JSON.parse((await fs.readFile(path, { encoding: 'utf-8' })) as string);
    } catch (err) {
      onError('unreadable bash job record; dropping it', err);
      await fs.rm(path).catch(() => undefined);
      return null;
    }
    if (!isRecord(record) || record.bootId === bootId) return null;
    const notice = kernelRestartNotice(record);
    await fs.appendFile(record.outputPath, notice).catch((err) => {
      onError('could not append the restart notice to a job output file', err);
    });
    report(record, notice);
    await fs.rm(path).catch(() => undefined);
    return record;
  };

  return {
    async record(partial) {
      try {
        await fs.mkdir(dir, { recursive: true });
        const record: BashJobRecord = { ...partial, bootId };
        await fs.writeFile(pathFor(bootId, record.jobId), JSON.stringify(record));
      } catch (err) {
        onError('could not record a detached bash job', err);
      }
    },
    async clear(jobId) {
      await fs.rm(pathFor(bootId, jobId)).catch(() => undefined);
    },
    async sweep(report) {
      let names: string[];
      try {
        names = (await fs.readDir(dir))
          .filter((e) => e.type === 'file' && e.name.endsWith('.json'))
          .map((e) => e.name);
      } catch {
        return [];
      }
      const reported: BashJobRecord[] = [];
      for (const name of names) {
        if (name.startsWith(`${bootId}.`)) continue;
        try {
          const record = await sweepOne(name, report);
          if (record) reported.push(record);
        } catch (err) {
          onError('failed to sweep a bash job record', err);
        }
      }
      return reported;
    },
  };
}
