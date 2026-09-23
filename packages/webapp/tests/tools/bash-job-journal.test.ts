import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VirtualFS } from '../../src/fs/index.js';
import type { AlmostBashShellHeadless } from '../../src/shell/almost-bash-shell-headless.js';
import {
  BASH_JOB_JOURNAL_DIR,
  type BashJobRecord,
  createBashJobJournal,
  KERNEL_BOOT_ID,
  KERNEL_RESTART_EXIT_CODE,
} from '../../src/tools/bash-job-journal.js';
import { createBashTool } from '../../src/tools/bash-tool.js';

let dbCounter = 0;
const JOURNAL = `/tmp/${BASH_JOB_JOURNAL_DIR}`;

function pendingShell() {
  let settle!: (result: { stdout: string; stderr: string; exitCode: number }) => void;
  const shell = {
    executeCommand: () =>
      new Promise<{ stdout: string; stderr: string; exitCode: number }>((res) => {
        settle = res;
      }),
  };
  return {
    shell: shell as unknown as AlmostBashShellHeadless,
    settle: (r: { stdout: string; stderr: string; exitCode: number }) => settle(r),
  };
}

async function journalFiles(fs: VirtualFS): Promise<string[]> {
  try {
    return (await fs.readDir(JOURNAL)).map((e) => e.name);
  } catch {
    return [];
  }
}

async function plantOrphan(fs: VirtualFS, partial: Partial<BashJobRecord> = {}): Promise<void> {
  const record: BashJobRecord = {
    bootId: 'dead-boot',
    jobId: 'bg-1',
    pid: 42,
    command: 'hf download ai-ecoverse/kev.js',
    outputPath: '/tmp/bash-bg-1.txt',
    startedAt: '2026-09-23T11:42:00.000Z',
    ...partial,
  };
  await fs.mkdir(JOURNAL, { recursive: true });
  await fs.writeFile(`${JOURNAL}/${record.bootId}.${record.jobId}.json`, JSON.stringify(record));
}

describe('bash job journal', () => {
  let fs: VirtualFS;
  beforeEach(async () => {
    fs = await VirtualFS.create({ dbName: `test-bash-journal-${dbCounter++}`, wipe: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('records a detached job while it runs and clears it once it settles', async () => {
    const { shell, settle } = pendingShell();
    const fireLick = vi.fn();
    const bash = createBashTool(shell, fs, '/tmp', { fireLick });
    await bash.execute({ command: 'hf download big/model', background_after: 0 });

    await vi.waitFor(async () => expect(await journalFiles(fs)).toHaveLength(1));
    const [name] = await journalFiles(fs);
    expect(name).toBe(`${KERNEL_BOOT_ID}.bg-1.json`);
    const record = JSON.parse(
      (await fs.readFile(`${JOURNAL}/${name}`, { encoding: 'utf-8' })) as string
    );
    expect(record).toMatchObject({
      bootId: KERNEL_BOOT_ID,
      jobId: 'bg-1',
      command: 'hf download big/model',
      outputPath: '/tmp/bash-bg-1.txt',
    });

    settle({ stdout: 'done\n', stderr: '', exitCode: 0 });
    await vi.waitFor(() => expect(fireLick).toHaveBeenCalledTimes(1));
    await vi.waitFor(async () => expect(await journalFiles(fs)).toEqual([]));
  });

  it('reports a job orphaned by a kernel restart as a failed bash lick', async () => {
    await fs.mkdir('/tmp', { recursive: true });
    await fs.writeFile('/tmp/bash-bg-1.txt', 'hf: downloaded model.onnx.data_1 (27.0 MB)\n');
    await plantOrphan(fs);
    const fireLick = vi.fn();
    createBashTool(pendingShell().shell, fs, '/tmp', { fireLick, targetScoop: 'bench' });

    await vi.waitFor(() => expect(fireLick).toHaveBeenCalledTimes(1));
    const event = fireLick.mock.calls[0][0];
    expect(event).toMatchObject({
      type: 'bash',
      bashJobId: 'bg-1',
      bashJobPid: 42,
      bashCommand: 'hf download ai-ecoverse/kev.js',
      bashExitCode: KERNEL_RESTART_EXIT_CODE,
      resultPath: '/tmp/bash-bg-1.txt',
      targetScoop: 'bench',
    });
    expect(event.preview).toMatch(/kernel worker restarted/);
    const output = (await fs.readFile('/tmp/bash-bg-1.txt', { encoding: 'utf-8' })) as string;
    expect(output).toMatch(/^hf: downloaded model\.onnx\.data_1/);
    expect(output).toMatch(/did not finish: the kernel worker restarted/);
    await vi.waitFor(async () => expect(await journalFiles(fs)).toEqual([]));
  });

  it('lets the restart notice land before a new job reuses the same output file', async () => {
    await plantOrphan(fs);
    const fireLick = vi.fn();
    const { shell, settle } = pendingShell();
    const bash = createBashTool(shell, fs, '/tmp', { fireLick });
    await bash.execute({ command: 'echo new', background_after: 0 });
    settle({ stdout: 'new job\n', stderr: '', exitCode: 0 });

    await vi.waitFor(() => expect(fireLick).toHaveBeenCalledTimes(2));
    expect(fireLick.mock.calls[0][0].bashExitCode).toBe(KERNEL_RESTART_EXIT_CODE);
    expect(fireLick.mock.calls[1][0].bashExitCode).toBe(0);
    expect(await fs.readFile('/tmp/bash-bg-1.txt', { encoding: 'utf-8' })).toContain('new job');
  });

  it('retries the report until the lick sink is attached', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    await plantOrphan(fs);
    let attached = false;
    const delivered: unknown[] = [];
    createBashTool(pendingShell().shell, fs, '/tmp', {
      fireLick: (event) => {
        if (!attached) return false;
        delivered.push(event);
        return true;
      },
    });
    await vi.waitFor(async () => expect(await journalFiles(fs)).toEqual([]));
    expect(delivered).toHaveLength(0);
    attached = true;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(delivered).toHaveLength(1);
  });

  it('leaves records from the current boot alone and drops unreadable ones', async () => {
    await plantOrphan(fs, { bootId: KERNEL_BOOT_ID });
    await fs.writeFile(`${JOURNAL}/garbage.json`, '{not json');
    const errors: string[] = [];
    const journal = createBashJobJournal(fs, '/tmp', KERNEL_BOOT_ID, (message) =>
      errors.push(message)
    );
    const report = vi.fn();
    expect(await journal.sweep(report)).toEqual([]);
    expect(report).not.toHaveBeenCalled();
    expect(await journalFiles(fs)).toEqual([`${KERNEL_BOOT_ID}.bg-1.json`]);
    expect(errors).toEqual(['unreadable bash job record; dropping it']);
  });

  it('never rejects when the filesystem refuses', async () => {
    const broken = {
      mkdir: async () => {
        throw new Error('EACCES');
      },
      writeFile: async () => undefined,
      appendFile: async () => undefined,
      readDir: async () => {
        throw new Error('ENOENT');
      },
      readFile: async () => '',
      rm: async () => {
        throw new Error('ENOENT');
      },
    } as unknown as VirtualFS;
    const errors: string[] = [];
    const journal = createBashJobJournal(broken, '/tmp', 'boot', (m) => errors.push(m));
    await expect(
      journal.record({ jobId: 'bg-1', command: 'x', outputPath: '/tmp/o', startedAt: '' })
    ).resolves.toBeUndefined();
    await expect(journal.clear('bg-1')).resolves.toBeUndefined();
    await expect(journal.sweep(vi.fn())).resolves.toEqual([]);
    expect(errors).toEqual(['could not record a detached bash job']);
  });
});
