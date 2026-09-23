import type { VirtualFS } from '../fs/index.js';

export const BASH_JOB_JOURNAL_DIR = '.bash-jobs';

export const KERNEL_BOOT_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export const KERNEL_RESTART_EXIT_CODE = 137;

export interface BashJobRecord {
  bootId: string;
  jobId: string;
  pid?: number;
  command: string;
  outputPath: string;
  startedAt: string;
}

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
  record(record: Omit<BashJobRecord, 'bootId'>): Promise<void>;

  clear(jobId: string): Promise<void>;

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
