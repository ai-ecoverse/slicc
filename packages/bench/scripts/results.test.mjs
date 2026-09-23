import { describe, expect, it } from 'vitest';
import { configKey, pairedDelta, reportMarkdown, summarize, summaryFileName } from './results.mjs';

const S = (model, skills) => ({ harness: '6.183.0', model, skills });
function rec(task, model, skills, score, extra = {}) {
  return {
    benchmark: 'B',
    task_id: task,
    repeat: 1,
    config: S(model, skills),
    score,
    verdict: score === 1,
    outcome: score === 1 ? 'pass' : score > 0 ? 'partial' : 'fail',
    metrics: { steps: 3, duration: 10, cost: 0.1, tokens: 100 },
    ...extra,
  };
}

const RECORDS = [
  rec('t1', 'sonnet', 'none', 0.5),
  rec('t1', 'sonnet', 'builtin', 1),
  rec('t2', 'sonnet', 'none', 0),
  rec('t2', 'sonnet', 'builtin', 1),
  rec('t1', 'opus', 'builtin', 1, { metrics: { steps: 2, duration: 20, cost: 0.3 } }),
  rec('t2', 'opus', 'builtin', 0.5, { metrics: { steps: 2, duration: 20, cost: 0.3 } }),
  {
    benchmark: 'B',
    task_id: 't3',
    repeat: 1,
    config: S('sonnet', 'none'),
    error: 'leader unreachable',
  },
];

describe('file names', () => {
  it('follows browser-use result naming, made path-safe', () => {
    expect(summaryFileName('BU_Bench_V1', S('claude-opus-5-5', 'builtin+ecoverse'))).toBe(
      'SLICC_6.183.0_skills_builtin+ecoverse_model_claude-opus-5-5_bench_BU_Bench_V1.json'
    );
    expect(summaryFileName('a b/c', { harness: 'x y', model: 'm', skills: 's' })).toBe(
      'SLICC_x-y_skills_s_model_m_bench_a-b-c.json'
    );
    expect(configKey(S('m', 's'))).toBe('m|s');
  });
});

describe('summarize', () => {
  it('keeps upstream fields, adds rubric counts, and never counts an error as a fail', () => {
    const sums = summarize(RECORDS, { runStart: 'T0', judgeModel: 'judge' });
    const none = sums.find((s) => s.body[0].skills === 'none' && s.body[0].model === 'sonnet')
      .body[0];
    expect(none).toMatchObject({
      run_start: 'T0',
      tasks_completed: 2,
      tasks_successful: 0,
      total_steps: 6,
      total_duration: 20,
      total_cost: 0.2,
      judge_model: 'judge',
      mean_score: 0.25,
      pass: 0,
      partial: 1,
      fail: 1,
      errors: 1,
    });
    expect(none.runs.find((r) => r.task_id === 't3')).toEqual({
      task_id: 't3',
      repeat: 1,
      score: null,
      outcome: null,
      duration: null,
      cost: null,
      error: 'leader unreachable',
    });
    expect(sums).toHaveLength(3);
    expect(summarize([rec('t', 'm', 's', 1, { metrics: undefined })])[0].body[0]).toMatchObject({
      total_steps: 0,
      run_start: null,
      judge_model: null,
    });
  });
});

describe('pairedDelta', () => {
  it('compares only tasks both sides judged', () => {
    expect(pairedDelta(RECORDS, S('sonnet', 'none'), S('sonnet', 'builtin'))).toEqual({
      n: 2,
      delta: 0.75,
    });
    expect(
      pairedDelta(RECORDS, S('sonnet', 'builtin'), S('opus', 'builtin'), 'cost').delta
    ).toBeCloseTo(0.2);
    expect(pairedDelta(RECORDS, S('sonnet', 'builtin'), S('nobody', 'builtin'))).toEqual({
      n: 0,
      delta: null,
    });
  });
});

describe('reportMarkdown', () => {
  it('tables every configuration and states skill and model deltas', () => {
    const md = reportMarkdown(RECORDS, { judgeModel: 'judge' });
    expect(md).toContain('Judge: `judge`');
    expect(md).toContain('| sonnet | none | 3 | 0 | 1 | 1 | 1 | 0.25 | 10 | 0.100 |');
    expect(md).toContain('**What skills change**');
    expect(md).toContain('- sonnet, `builtin`: score +0.75');
    expect(md).toContain('**What models change**');
    expect(md).toContain('- `builtin`, opus: score -0.25');
    expect(md).toContain('(n=0)');
  });

  it('omits deltas for a single configuration', () => {
    const md = reportMarkdown([rec('t1', 'm', 's', 1)]);
    expect(md).not.toContain('What skills change');
    expect(md).not.toContain('What models change');
    expect(md).not.toContain('Judge:');
  });
});
