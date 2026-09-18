import { afterEach, describe, expect, it } from 'vitest';
import { JobTable, kernelJobTable } from '../../src/kernel/job-table.js';

describe('JobTable', () => {
  afterEach(() => {
    kernelJobTable.clear();
  });

  it('upserts, lists, and removes named jobs', () => {
    const table = new JobTable();
    table.upsert({
      id: 'jshd:phone',
      kind: 'jshd',
      pid: 1024,
      argv: ['/workspace/phone.jsh'],
      status: 'running',
      startedAt: 1,
      restarts: 0,
    });
    table.upsert({
      id: 'bash:1025',
      kind: 'bash',
      pid: 1025,
      argv: ['bash', '-c', 'sleep 9'],
      status: 'running',
      startedAt: 2,
      restarts: 0,
    });
    expect(table.list().map((job) => job.id)).toEqual(['jshd:phone', 'bash:1025']);
    table.remove('bash:1025');
    expect(table.get('bash:1025')).toBeUndefined();
    expect(table.get('jshd:phone')?.pid).toBe(1024);
  });

  it('copies argv so callers cannot mutate stored records', () => {
    const table = new JobTable();
    const argv = ['a'];
    table.upsert({
      id: 'jshd:x',
      kind: 'jshd',
      pid: 1,
      argv,
      status: 'running',
      startedAt: 0,
      restarts: 0,
    });
    argv.push('b');
    expect(table.get('jshd:x')?.argv).toEqual(['a']);
  });
});
