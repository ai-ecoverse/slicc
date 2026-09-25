import { describe, expect, it } from 'vitest';
import { pathSegment } from './format.mjs';
import {
  configKey,
  judgeModels,
  pairedDelta,
  reportData,
  reportMarkdown,
  skillsBaseline,
  summarize,
  summaryFileName,
} from './results.mjs';

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
    judge: { model: 'judge' },
    ...extra,
  };
}

function unjudged(task, model, skills, extra = {}) {
  return {
    benchmark: 'B',
    task_id: task,
    repeat: 1,
    config: S(model, skills),
    metrics: { steps: 5, duration: 30, cost: 0.2 },
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
    error_stage: 'run',
  },
];

describe('file names', () => {
  it('follows browser-use result naming and keeps distinct names distinct', () => {
    expect(summaryFileName('BU_Bench_V1', S('claude-opus-5-5', 'builtin+ecoverse'))).toBe(
      'SLICC_6.183.0_skills_builtin+ecoverse_model_claude-opus-5-5_bench_BU_Bench_V1.json'
    );
    expect(summaryFileName('a b/c', { harness: 'x y', model: 'm', skills: 's' })).toBe(
      `SLICC_${pathSegment('x y')}_skills_s_model_m_bench_${pathSegment('a b/c')}.json`
    );
    expect(summaryFileName('a/b', S('m', 's'))).not.toBe(summaryFileName('a b', S('m', 's')));
    expect(configKey(S('m', 's'))).toBe('m|s');
  });
});

describe('judgeModels', () => {
  it('names the judges behind scored runs only', () => {
    expect(judgeModels(RECORDS)).toEqual(['judge']);
    expect(
      judgeModels([
        rec('t', 'm', 's', 1, { judge: { model: 'b' } }),
        rec('t', 'm', 's', 1, { judge: { model: 'a' } }),
      ])
    ).toEqual(['a', 'b']);
    expect(
      judgeModels([rec('t', 'm', 's', 1, { judge: undefined }), unjudged('t', 'm', 's')])
    ).toEqual(['unknown']);
    expect(judgeModels([unjudged('t', 'm', 's')])).toEqual([]);
  });
});

describe('summarize', () => {
  it('keeps upstream fields, adds rubric counts, and never counts an error as a fail', () => {
    const sums = summarize(RECORDS, { runStart: 'T0' });
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
      not_judged: 0,
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
  });

  it('counts unjudged runs for time and cost but never scores them', () => {
    const [sum] = summarize([
      rec('t1', 'm', 's', 1),
      unjudged('t2', 'm', 's'),
      unjudged('t3', 'm', 's', { error: 'judge HTTP 500', error_stage: 'judge' }),
    ]);
    const body = sum.body[0];
    expect(body).toMatchObject({
      tasks_completed: 1,
      tasks_successful: 1,
      mean_score: 1,
      not_judged: 2,
      errors: 0,
      total_steps: 13,
      total_duration: 70,
      total_cost: 0.5,
    });
    expect(body.runs[1]).toMatchObject({ score: null, outcome: null, duration: 30 });
    const only = summarize([
      unjudged('t', 'm', 's'),
      rec('u', 'm', 's', 1, { metrics: undefined }),
    ])[0].body[0];
    expect(only).toMatchObject({ run_start: null, mean_score: 1, not_judged: 1, total_steps: 5 });
    expect(summarize([unjudged('t', 'm', 's')])[0].body[0]).toMatchObject({
      mean_score: null,
      judge_model: null,
    });
  });
});

describe('pairedDelta', () => {
  it('pairs scores over runs both sides judged', () => {
    const d = pairedDelta(RECORDS, S('sonnet', 'none'), S('sonnet', 'builtin'));
    expect(d).toMatchObject({ n: 2, delta: 0.75 });
    expect(d.to - d.from).toBeCloseTo(0.75);
    expect(pairedDelta(RECORDS, S('sonnet', 'builtin'), S('nobody', 'builtin'))).toEqual({
      n: 0,
      delta: null,
      from: null,
      to: null,
    });
  });

  it('pairs time and cost over runs both sides finished, judged or not', () => {
    expect(
      pairedDelta(RECORDS, S('sonnet', 'builtin'), S('opus', 'builtin'), 'cost').delta
    ).toBeCloseTo(0.2);
    const records = [unjudged('t1', 'a', 's'), rec('t1', 'b', 's', 1)];
    expect(pairedDelta(records, S('a', 's'), S('b', 's'))).toEqual({
      n: 0,
      delta: null,
      from: null,
      to: null,
    });
    expect(pairedDelta(records, S('a', 's'), S('b', 's'), 'duration')).toMatchObject({
      n: 1,
      delta: -20,
    });
    expect(
      pairedDelta(
        [unjudged('t1', 'a', 's', { metrics: undefined }), unjudged('t1', 'b', 's')],
        S('a', 's'),
        S('b', 's'),
        'duration'
      )
    ).toEqual({ n: 0, delta: null, from: null, to: null });
  });

  it('leaves unmeasured cost out of means, totals and pairs, and counts it', () => {
    const records = [
      rec('t1', 'a', 's', 1, { metrics: { duration: 10, cost: 0.2 } }),
      rec('t2', 'a', 's', 1, { metrics: { duration: 30, cost: null } }),
      rec('t1', 'b', 's', 1, { metrics: { duration: 20, cost: null } }),
    ];
    const [a] = summarize(records).filter((s) => s.body[0].model === 'a');
    expect(a.body[0]).toMatchObject({ total_cost: 0.2, cost_unknown: 1, total_duration: 40 });
    expect(pairedDelta(records, S('a', 's'), S('b', 's'), 'cost')).toEqual({
      n: 0,
      delta: null,
      from: null,
      to: null,
    });
    expect(pairedDelta(records, S('a', 's'), S('b', 's'), 'duration')).toEqual({
      n: 1,
      delta: 10,
      from: 10,
      to: 20,
    });
  });
});

describe('tool use', () => {
  const tooled = (task, skills, score, withoutTools) =>
    rec(task, 'm', skills, score, {
      metrics: {
        duration: 10,
        cost: 0.1,
        answered_without_tools: withoutTools,
        tool_calls: withoutTools ? 0 : 3,
      },
    });
  it('counts runs that answered without tools, and scores them apart', () => {
    const records = [
      tooled('t1', 'none', 0.8, true),
      tooled('t2', 'none', 1, false),
      tooled('t3', 'none', 0, true),
      rec('t4', 'm', 'none', 1),
    ];
    const [c] = reportData(records).benchmarks[0].configs;
    expect(c).toMatchObject({
      tool_known: 3,
      no_tool_runs: 2,
      no_tool_rate: 0.6667,
      no_tool_mean_score: 0.4,
      tool_mean_score: 1,
    });
    const md = reportMarkdown(records);
    expect(md).toContain('**Answered without tools**');
    expect(md).toContain('- m, `none`: 2/3 (67%), mean score 0.40 without tools vs 1.00 with');
    expect(reportMarkdown([rec('t1', 'm', 'none', 1)])).not.toContain('Answered without tools');
    expect(reportData([rec('t1', 'm', 'none', 1)]).benchmarks[0].configs[0]).toMatchObject({
      tool_known: 0,
      no_tool_rate: null,
      no_tool_mean_score: null,
    });
  });
});

describe('skills lift', () => {
  it('measures from none whenever it ran, whatever order the conditions came in', () => {
    expect(skillsBaseline(['builtin', 'none'])).toBe('none');
    expect(skillsBaseline(['builtin', 'builtin+x'])).toBe('builtin');
    const records = [
      rec('t1', 'm', 'builtin', 1),
      rec('t2', 'm', 'builtin', 0.8),
      rec('t1', 'm', 'none', 0.6),
      rec('t2', 'm', 'none', 0.8),
    ];
    const [lift] = reportData(records).benchmarks[0].skill_deltas;
    expect(lift).toMatchObject({
      model: 'm',
      from: 'none',
      to: 'builtin',
      n: 2,
      score_from: 0.7,
      score_to: 0.9,
    });
    expect(lift.score).toBeCloseTo(0.2);
  });
});

describe('reportMarkdown', () => {
  it('tables every configuration and states skill and model deltas', () => {
    const md = reportMarkdown(RECORDS);
    expect(md).toContain('Judge: `judge`');
    expect(md).toContain('| sonnet | none | 3 | 0 | 1 | 1 | 0 | 1 | 0.25 | 10 | 0.100 |');
    expect(md).toContain('**What skills add** (lift over `none`, paired by task and repeat):');
    expect(md).toContain('- sonnet, `builtin`: score +300.0% (0.25 → 1.00)');
    expect(md).toContain('**What models change**');
    expect(md).toMatch(/- `builtin`, opus: score -\d+\.\d% \(\d\.\d\d → \d\.\d\d\)/);
    expect(md).toContain('(n=0)');
  });

  it('shows unjudged runs as such, never as NaN, and names no judge for them', () => {
    const md = reportMarkdown([unjudged('t1', 'm', 'none'), unjudged('t1', 'm', 'builtin')]);
    expect(md).not.toContain('NaN');
    expect(md).not.toContain('Judge:');
    expect(md).toContain('| m | none | 1 | 0 | 0 | 0 | 1 | 0 | – | 30 | 0.200 |');
    expect(md).toContain(
      '- m, `builtin`: score – (– → –), time +0.0% (+0 s), cost +0.0% (+0.000 $) (n=0)'
    );
  });

  it('omits deltas for a single configuration', () => {
    const md = reportMarkdown([rec('t1', 'm', 's', 1)]);
    expect(md).not.toContain('What skills add');
    expect(md).not.toContain('What models change');
  });
});
