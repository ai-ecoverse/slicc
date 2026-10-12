import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  chainProgress,
  githubOutputLines,
  memoryRestoredForOut,
  pickNextChainRun,
} from './chain-plan.mjs';
import { taskDigests } from './format.mjs';
import { memoryCheckpointPath } from './memory-checkpoint.mjs';

const dirs = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'bench-chain-'));
  dirs.push(d);
  return d;
}

const TASK_A = {
  id: 't-a',
  task: 'Do A.',
  rubric: '# Rubric\n## Items\nA1 — yes\n',
  weights: { A1: 100 },
};
const TASK_B = {
  id: 't-b',
  task: 'Do B.',
  rubric: '# Rubric\n## Items\nB1 — yes\n',
  weights: { B1: 100 },
};

function run(task, { model = 'm', skills = 'builtin', repeat = 1 } = {}) {
  return {
    task,
    model,
    repeat,
    condition: { name: skills, builtin: skills.includes('builtin') },
    set: { benchmark: 'Test', encrypted: false },
  };
}

function writeRecord(out, r, overrides = {}) {
  const d = taskDigests(r.task);
  const path = join(
    out,
    'records',
    'Test',
    r.condition.name,
    r.model,
    `${r.task.id}-r${r.repeat}.json`
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      task_id: r.task.id,
      digests: d,
      score: 1,
      outcome: 'pass',
      judge: { model: 'j' },
      config: { default_skills: true, new_session: 'save' },
      ...overrides,
    })
  );
}

describe('memoryRestoredForOut', () => {
  it('is true for env flag or non-empty checkpoint', () => {
    const out = tmp();
    expect(memoryRestoredForOut(out, {})).toBe(false);
    expect(memoryRestoredForOut(out, { BENCH_MEMORY_RESTORED: '1' })).toBe(true);
    mkdirSync(join(out, 'memory'), { recursive: true });
    writeFileSync(memoryCheckpointPath(out), '# mem\n');
    expect(memoryRestoredForOut(out, {})).toBe(true);
  });
});

describe('pickNextChainRun', () => {
  it('picks the first unfinished run when memory is restored', () => {
    const out = tmp();
    mkdirSync(join(out, 'memory'), { recursive: true });
    writeFileSync(memoryCheckpointPath(out), '# mem\n');
    const runs = [run(TASK_A), run(TASK_B)];
    writeRecord(out, runs[0]);
    const opts = {
      out,
      judge: true,
      judgeModel: 'j',
      newSession: 'save',
      arm: null,
    };
    const pick = pickNextChainRun(runs, opts, { memoryRestored: true });
    expect(pick).toMatchObject({ complete: false, taskId: 't-b', action: 'run' });
    expect(chainProgress(runs, opts, { memoryRestored: true })).toEqual({
      done: 1,
      left: 1,
      total: 2,
    });
  });

  it('replays scored save tasks when memory was not restored', () => {
    const out = tmp();
    const runs = [run(TASK_A), run(TASK_B)];
    writeRecord(out, runs[0]);
    const opts = { out, judge: true, judgeModel: 'j', newSession: 'save', arm: null };
    const pick = pickNextChainRun(runs, opts, { memoryRestored: false });
    expect(pick).toMatchObject({ complete: false, taskId: 't-a', action: 'run' });
  });

  it('reports complete when every run is done with memory restored', () => {
    const out = tmp();
    const runs = [run(TASK_A), run(TASK_B)];
    writeRecord(out, runs[0]);
    writeRecord(out, runs[1]);
    const opts = { out, judge: true, judgeModel: 'j', newSession: 'save', arm: null };
    expect(pickNextChainRun(runs, opts, { memoryRestored: true }).complete).toBe(true);
  });
});

describe('githubOutputLines', () => {
  it('emits Actions output keys', () => {
    const lines = githubOutputLines(
      { complete: false, taskId: 't-b', action: 'run', model: 'm', skills: 'builtin', repeat: 1 },
      { done: 1, left: 1, total: 2 },
      true
    );
    expect(lines).toContain('next_task=t-b');
    expect(lines).toContain('memory_restored=true');
    expect(lines).toContain('complete=false');
  });
});
