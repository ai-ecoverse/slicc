import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { withDigests } from './format.mjs';
import {
  datasetCard,
  listFiles,
  main,
  parsePublishCli,
  publicRecord,
  REPORT_MARKER,
  stage,
  taskSetEnvelope,
} from './publish.mjs';
import { decryptSetFile, encryptJson } from './upstream.mjs';

const TASK = withDigests({
  id: 'own-1',
  task: 'Report the heading.',
  rubric: '## Items\nA1_heading — the heading\n',
  weights: { A1_heading: 100 },
});

function tmp() {
  return mkdtempSync(join(tmpdir(), 'bench-publish-'));
}

function write(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof text === 'string' ? text : JSON.stringify(text));
}

const record = (benchmark, model, taskId, extra = {}) => ({
  benchmark,
  task_id: taskId,
  repeat: 1,
  config: { harness: 'h', model, skills: 'builtin' },
  score: 1,
  verdict: true,
  outcome: 'pass',
  statuses: { A1_heading: 'met' },
  metrics: { steps: 3, duration: 10, cost: 0.05 },
  judge: { model: 'j' },
  ...extra,
});

/** A run's out dir: one own-set run with a plain trace, one upstream run with an encrypted one. */
function outDir() {
  const out = tmp();
  const own = record('SLICC_Smoke', 'claude-opus-5-5', 'own-1', {
    metrics: { steps: 3, duration: 10, cost: 0.05, tabs: ['https://example.com/?q=own'] },
  });
  const upstream = record('BU_Bench_V1', 'claude-opus-5-5', 'u1', {
    statuses: { A1_answer: 'met', A2_grounded: 'violated' },
    score: 0.7,
    outcome: 'partial',
    verdict: false,
  });
  write(join(out, 'records/SLICC_Smoke/builtin/claude-opus-5-5/own-1-r1.json'), own);
  write(join(out, 'records/BU_Bench_V1/builtin/claude-opus-5-5/u1-r1.json'), upstream);
  write(join(out, 'results/SLICC_x.json'), [{ tasks_completed: 1 }]);
  write(join(out, 'report.md'), '## run report\n');
  write(join(out, 'traces/SLICC_Smoke/builtin/claude-opus-5-5/own-1-r1.json'), {
    record: own,
    task: TASK,
    result: { finalText: 'FINAL ANSWER: Example Domain' },
  });
  write(
    join(out, 'traces/BU_Bench_V1/builtin/claude-opus-5-5/u1-r1.json.enc'),
    encryptJson({ task: { task: 'secret upstream text' } }, 'BU_Bench_V1')
  );
  return out;
}

function setFile(dir) {
  const path = join(dir, 'smoke.json');
  write(path, { benchmark: 'SLICC_Smoke', tasks: [TASK] });
  return path;
}

describe('parsePublishCli', () => {
  it('needs a stage, a run name with --out, and something to publish', () => {
    expect(parsePublishCli(['--stage', 's', '--out', 'o', '--run', '20260924-1'])).toMatchObject({
      run: '20260924-1',
      dataset: null,
      sets: [],
    });
    expect(parsePublishCli(['--stage', 's', '--dataset', 'd']).out).toBeNull();
    expect(() => parsePublishCli(['--out', 'o'])).toThrow(/--stage/);
    expect(() => parsePublishCli(['--stage', 's', '--out', 'o', '--run', '../x'])).toThrow(/--run/);
    expect(() => parsePublishCli(['--stage', 's'])).toThrow(/--out, --dataset/);
  });
});

describe('what may be published', () => {
  it("turns upstream item statuses into counts and leaves SLICC's records alone", () => {
    const up = publicRecord(
      record('BU_Bench_V2', 'm', 't', { statuses: { A1_x: 'met', A2_y: 'met', A3_z: 'violated' } })
    );
    expect(up.statuses).toBeUndefined();
    expect(up.status_counts).toEqual({ met: 2, violated: 1 });
    const own = record('SLICC_Smoke', 'm', 't', {
      metrics: { duration: 3, tabs: ['https://example.com/?q=secret'] },
    });
    expect(publicRecord(own)).toEqual({ ...own, metrics: { duration: 3 } });
    expect(own.metrics.tabs).toHaveLength(1);
    const errored = { benchmark: 'BU_Bench_V1', error: 'x' };
    expect(publicRecord(errored)).toEqual(errored);
  });

  it('publishes our own task sets and refuses upstream ones', () => {
    const dir = tmp();
    expect(taskSetEnvelope('bu-v1')).toBeNull();
    expect(taskSetEnvelope(setFile(dir)).benchmark).toBe('SLICC_Smoke');
    const evals = join(dir, 'evals.json');
    write(evals, { skill_name: 'speck', evals: [{ id: 1, prompt: 'p', expectations: ['e'] }] });
    expect(taskSetEnvelope(evals).benchmark).toBe('speck-evals');
    const stolen = join(dir, 'stolen.json');
    write(stolen, { benchmark: 'BU_Bench_V2', tasks: [TASK] });
    expect(() => taskSetEnvelope(stolen)).toThrow(/not ours to publish/);
    const bad = join(dir, 'bad.json');
    write(bad, { benchmark: 'B', tasks: [{ ...TASK, weights: { A1_heading: 5 } }] });
    expect(() => taskSetEnvelope(bad)).toThrow(/bad\.json: .*100/);
  });

  it('fills the card with the report', () => {
    expect(datasetCard(`# Card\n\n${REPORT_MARKER}\n`, [])).toContain('No runs published yet.');
    expect(
      datasetCard(`# Card\n\n${REPORT_MARKER}\n`, [record('SLICC_Smoke', 'm', 't')])
    ).toContain('## Latest results');
    expect(() => datasetCard('# Card', [])).toThrow(/lacks/);
  });
});

describe('stage', () => {
  it('stages the run, encrypted own traces, merged records, results, report and card', () => {
    const out = outDir();
    const dataset = tmp();
    const older = record('SLICC_Smoke', 'claude-sonnet-5', 'own-1', { score: 0, outcome: 'fail' });
    write(join(dataset, 'records/SLICC_Smoke/builtin/claude-sonnet-5/own-1-r1.json'), older);
    const replaced = record('SLICC_Smoke', 'claude-opus-5-5', 'own-1', { score: 0.1 });
    write(join(dataset, 'records/SLICC_Smoke/builtin/claude-opus-5-5/own-1-r1.json'), replaced);
    const dir = tmp();
    const target = join(dir, 'stage');

    const s = stage({ out, stage: target, run: 'r1', dataset, sets: ['bu-v1', setFile(dir)] });
    expect(s).toEqual({ records: 2, traces: 1, combined: 3, taskSets: ['SLICC_Smoke'] });

    const files = listFiles(target);
    expect(files).toContain('runs/r1/traces/SLICC_Smoke/builtin/claude-opus-5-5/own-1-r1.json.enc');
    expect(files.some((f) => f.includes('BU_Bench_V1') && f.includes('traces'))).toBe(false);
    expect(files).toContain('runs/r1/report.md');
    expect(files).toContain('runs/r1/results/SLICC_x.json');
    expect(files).not.toContain('runs/r1/report.json');
    const staged = files.map((f) => readFileSync(join(target, f), 'utf8')).join('\n');
    expect(staged).not.toContain('secret upstream text');
    expect(staged).not.toContain('Report the heading.');
    expect(staged).not.toContain('A2_grounded');
    expect(staged).not.toContain('example.com/?q=');

    const trace = decryptSetFile(
      readFileSync(
        join(target, 'runs/r1/traces/SLICC_Smoke/builtin/claude-opus-5-5/own-1-r1.json.enc'),
        'utf8'
      ),
      'SLICC_Smoke'
    );
    expect(trace.task.task).toBe('Report the heading.');
    const tasks = decryptSetFile(
      readFileSync(join(target, 'tasks/SLICC_Smoke.enc'), 'utf8'),
      'SLICC_Smoke'
    );
    expect(tasks.tasks[0].id).toBe('own-1');

    const report = JSON.parse(readFileSync(join(target, 'report.json'), 'utf8'));
    const smoke = report.benchmarks.find((b) => b.benchmark === 'SLICC_Smoke');
    expect(smoke.configs.map((c) => [c.model, c.mean_score])).toEqual([
      ['claude-opus-5-5', 1],
      ['claude-sonnet-5', 0],
    ]);
    expect(smoke.model_deltas[0]).toMatchObject({
      from: 'claude-opus-5-5',
      to: 'claude-sonnet-5',
      score: -1,
      n: 1,
    });
    expect(files.filter((f) => f.startsWith('results/'))).toHaveLength(3);
    expect(readFileSync(join(target, 'README.md'), 'utf8')).toMatch(
      /slicc-bench canary GUID[\s\S]*### SLICC_Smoke/
    );
    expect(
      existsSync(join(target, 'records/SLICC_Smoke/builtin/claude-sonnet-5/own-1-r1.json'))
    ).toBe(false);
  });

  it('rebuilds only the combined files from the dataset when there is no run', () => {
    const dataset = tmp();
    write(
      join(dataset, 'records/SLICC_Smoke/builtin/m/own-1-r1.json'),
      record('SLICC_Smoke', 'm', 'own-1')
    );
    const target = join(tmp(), 'stage');
    expect(
      stage({ out: null, stage: target, run: null, dataset: join(dataset), sets: [] })
    ).toEqual({
      records: 0,
      traces: 0,
      combined: 1,
      taskSets: [],
    });
    expect(listFiles(target).filter((f) => !f.startsWith('results/'))).toEqual([
      'README.md',
      'report.json',
      'report.md',
    ]);
    expect(listFiles(join(tmp(), 'missing'))).toEqual([]);
  });

  it('logs what it staged', () => {
    const log = vi.fn();
    const dir = tmp();
    expect(
      main(['--out', outDir(), '--stage', join(dir, 's'), '--run', 'r', '--set', setFile(dir)], {
        log,
      })
    ).toBe(0);
    expect(log).toHaveBeenCalledWith(
      'staged 2 run record(s), 1 encrypted trace(s), 2 record(s) in the combined report, task sets SLICC_Smoke'
    );
    main(['--dataset', tmp(), '--stage', join(dir, 't')], { log });
    expect(log).toHaveBeenLastCalledWith(
      'staged 0 run record(s), 0 encrypted trace(s), 0 record(s) in the combined report'
    );
  });
});
