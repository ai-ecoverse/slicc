import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertSingleChainConfig,
  chainProgress,
  githubOutputLines,
  main,
  memoryRestoredForOut,
  pickNextChainRun,
} from './chain-plan.mjs';
import { taskDigests } from './format.mjs';
import { memoryCheckpointPath } from './memory-checkpoint.mjs';
import { parseSkillsCondition } from './slicc-adapter.mjs';

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

describe('assertSingleChainConfig', () => {
  it('allows a single model and skills condition', () => {
    expect(() =>
      assertSingleChainConfig({
        models: ['claude-sonnet-5'],
        skills: [parseSkillsCondition('builtin')],
      })
    ).not.toThrow();
    expect(() => assertSingleChainConfig({})).not.toThrow();
  });

  it('rejects multiple models or skills', () => {
    expect(() =>
      assertSingleChainConfig({
        models: ['a', 'b'],
        skills: [parseSkillsCondition('builtin')],
      })
    ).toThrow(/one --models entry/);
    expect(() =>
      assertSingleChainConfig({
        models: ['a'],
        skills: [parseSkillsCondition('builtin'), parseSkillsCondition('none')],
      })
    ).toThrow(/one --skills entry/);
  });
});

describe('main', () => {
  const prevOut = process.env.GITHUB_OUTPUT;
  const prevSummary = process.env.GITHUB_STEP_SUMMARY;
  afterEach(() => {
    if (prevOut === undefined) delete process.env.GITHUB_OUTPUT;
    else process.env.GITHUB_OUTPUT = prevOut;
    if (prevSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY;
    else process.env.GITHUB_STEP_SUMMARY = prevSummary;
  });

  it('logs to stderr and stdout when GitHub env files are absent', async () => {
    delete process.env.GITHUB_OUTPUT;
    delete process.env.GITHUB_STEP_SUMMARY;
    const out = tmp();
    const printed = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await main([
      '--set',
      'packages/bench/tasks/smoke.json',
      '--models',
      'm',
      '--skills',
      'builtin',
      '--new-session',
      'save',
      '--out',
      out,
      '--no-judge',
      '--tasks',
      'smoke-001',
    ]);
    expect(code).toBe(0);
    expect(printed.mock.calls.some((c) => /next_task=smoke-001/.test(String(c[0])))).toBe(true);
    printed.mockRestore();
  });

  it('writes Actions outputs for the next unfinished smoke task', async () => {
    const out = tmp();
    const ghOut = join(out, 'gh-out');
    const summary = join(out, 'summary.md');
    writeFileSync(ghOut, '');
    writeFileSync(summary, '');
    process.env.GITHUB_OUTPUT = ghOut;
    process.env.GITHUB_STEP_SUMMARY = summary;
    const log = vi.fn();
    const code = await main(
      [
        '--set',
        'packages/bench/tasks/smoke.json',
        '--models',
        'm',
        '--skills',
        'builtin',
        '--new-session',
        'save',
        '--out',
        out,
        '--no-judge',
        '--tasks',
        'smoke-001',
      ],
      { log }
    );
    expect(code).toBe(0);
    const lines = readFileSync(ghOut, 'utf8');
    expect(lines).toMatch(/next_task=smoke-001/);
    expect(lines).toMatch(/complete=false/);
    expect(readFileSync(summary, 'utf8')).toMatch(/Next: `smoke-001`/);
    expect(log.mock.calls.some((c) => /next smoke-001/.test(c[0]))).toBe(true);
  });

  it('reports complete when every planned run is done with a restored checkpoint', async () => {
    const out = tmp();
    mkdirSync(join(out, 'memory'), { recursive: true });
    writeFileSync(memoryCheckpointPath(out), '# mem\n');
    const { loadAndPlan, parseCli, recordPath } = await import('./run.mjs');
    const opts = parseCli([
      '--set',
      'packages/bench/tasks/smoke.json',
      '--models',
      'm',
      '--skills',
      'builtin',
      '--new-session',
      'save',
      '--out',
      out,
      '--no-judge',
      '--tasks',
      'smoke-001',
    ]);
    const runs = await loadAndPlan(opts, {}, () => {});
    const r = runs[0];
    const rp = recordPath(out, r.set.benchmark, r.condition.name, r.model, r.task.id, r.repeat);
    mkdirSync(dirname(rp), { recursive: true });
    writeFileSync(
      rp,
      JSON.stringify({
        task_id: r.task.id,
        digests: taskDigests(r.task),
        score: 1,
        outcome: 'pass',
        config: { default_skills: true, new_session: 'save' },
      })
    );

    const ghOut = join(out, 'gh-out-2');
    const summary = join(out, 'summary-2.md');
    writeFileSync(ghOut, '');
    writeFileSync(summary, '');
    process.env.GITHUB_OUTPUT = ghOut;
    process.env.GITHUB_STEP_SUMMARY = summary;
    const log = vi.fn();
    await main(
      [
        '--set',
        'packages/bench/tasks/smoke.json',
        '--models',
        'm',
        '--skills',
        'builtin',
        '--new-session',
        'save',
        '--out',
        out,
        '--no-judge',
        '--tasks',
        'smoke-001',
      ],
      { log }
    );
    expect(readFileSync(ghOut, 'utf8')).toMatch(/complete=true/);
    expect(readFileSync(summary, 'utf8')).toMatch(/Complete:/);
    expect(log.mock.calls.some((c) => /chain complete/.test(c[0]))).toBe(true);
  });
});
