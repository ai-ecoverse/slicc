/**
 * Run records → result files and a report. Pure.
 *
 * A run record is `{ benchmark, task_id, repeat, config: { harness, model, skills }, score,
 * verdict, outcome, metrics: { steps, duration, cost, tokens }, error? }`. A record with `error`
 * never reached the judge; it is reported but never counted as a failure, because #3180's
 * matrix is sparse and an absent cell must not read as a fail.
 *
 * Summaries keep browser-use's result-file fields (`run_start`, `tasks_completed`,
 * `tasks_successful`, `total_steps`, `total_duration`, `total_cost`) so SLICC's files sit
 * beside theirs, and add the rubric-score view.
 */

import { OUTCOMES } from './format.mjs';

export function configKey(c) {
  return `${c.model}|${c.skills}`;
}

/** The result-file name, in browser-use's `<Framework>_<version>_browser_<b>_model_<m>` style. */
export function summaryFileName(benchmark, config) {
  const safe = (s) => String(s).replace(/[^A-Za-z0-9._+-]+/g, '-');
  return `SLICC_${safe(config.harness)}_skills_${safe(config.skills)}_model_${safe(config.model)}_bench_${safe(benchmark)}.json`;
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round = (x, d = 4) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);

/** One summary per (benchmark, model, skills). */
export function summarize(records, { runStart, judgeModel } = {}) {
  const groups = new Map();
  for (const r of records) {
    const key = `${r.benchmark}|${configKey(r.config)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return [...groups.values()].map((rs) => {
    const judged = rs.filter((r) => !r.error);
    const counts = Object.fromEntries(
      OUTCOMES.map((o) => [o, judged.filter((r) => r.outcome === o).length])
    );
    return {
      file: summaryFileName(rs[0].benchmark, rs[0].config),
      body: [
        {
          run_start: runStart ?? null,
          tasks_completed: judged.length,
          tasks_successful: judged.filter((r) => r.verdict).length,
          total_steps: judged.reduce((a, r) => a + (r.metrics?.steps ?? 0), 0),
          total_duration: round(
            judged.reduce((a, r) => a + (r.metrics?.duration ?? 0), 0),
            3
          ),
          total_cost: round(judged.reduce((a, r) => a + (r.metrics?.cost ?? 0), 0)),
          benchmark: rs[0].benchmark,
          harness: rs[0].config.harness,
          model: rs[0].config.model,
          skills: rs[0].config.skills,
          judge_model: judgeModel ?? null,
          mean_score: round(mean(judged.map((r) => r.score))),
          ...counts,
          errors: rs.length - judged.length,
          runs: rs.map((r) => ({
            task_id: r.task_id,
            repeat: r.repeat,
            score: r.error ? null : round(r.score),
            outcome: r.error ? null : r.outcome,
            duration: round(r.metrics?.duration ?? null, 1),
            cost: round(r.metrics?.cost ?? null),
            ...(r.error ? { error: r.error } : {}),
          })),
        },
      ],
    };
  });
}

/**
 * Mean score difference of `b` over `a` on the runs both judged, paired by task and repeat.
 * Pairing keeps an easy task that only one side ran from moving the delta.
 */
export function pairedDelta(records, a, b, field = 'score') {
  const index = (cfg) => {
    const m = new Map();
    for (const r of records) {
      if (!r.error && configKey(r.config) === configKey(cfg))
        m.set(`${r.benchmark}|${r.task_id}|${r.repeat}`, r);
    }
    return m;
  };
  const ia = index(a);
  const ib = index(b);
  const diffs = [];
  for (const [k, ra] of ia) {
    const rb = ib.get(k);
    if (rb)
      diffs.push(
        (field === 'score' ? rb.score : (rb.metrics?.[field] ?? 0)) -
          (field === 'score' ? ra.score : (ra.metrics?.[field] ?? 0))
      );
  }
  return {
    n: diffs.length,
    delta: diffs.length ? diffs.reduce((x, y) => x + y, 0) / diffs.length : null,
  };
}

const fmt = (x, d = 2) => (x == null ? '–' : x.toFixed(d));
const signed = (x, d = 2) => (x == null ? '–' : `${x >= 0 ? '+' : ''}${x.toFixed(d)}`);

/** Markdown for the job summary: one row per configuration, then skill and model deltas. */
export function reportMarkdown(records, { title = 'SLICC benchmark', judgeModel } = {}) {
  const lines = [`## ${title}`, ''];
  if (judgeModel)
    lines.push(`Judge: \`${judgeModel}\`. Scores are rubric fractions; pass = every item met.`, '');
  const benchmarks = [...new Set(records.map((r) => r.benchmark))];
  for (const bench of benchmarks) {
    const rs = records.filter((r) => r.benchmark === bench);
    const configs = [...new Map(rs.map((r) => [configKey(r.config), r.config])).values()];
    lines.push(
      `### ${bench}`,
      '',
      '| model | skills | runs | pass | partial | fail | errors | mean score | mean s | mean $ |',
      '|---|---|---|---|---|---|---|---|---|---|'
    );
    for (const c of configs) {
      const cs = rs.filter((r) => configKey(r.config) === configKey(c));
      const j = cs.filter((r) => !r.error);
      const n = (o) => j.filter((r) => r.outcome === o).length;
      lines.push(
        `| ${c.model} | ${c.skills} | ${cs.length} | ${n('pass')} | ${n('partial')} | ${n('fail')} | ${cs.length - j.length} | ${fmt(mean(j.map((r) => r.score)))} | ${fmt(mean(j.map((r) => r.metrics?.duration ?? 0)), 0)} | ${fmt(mean(j.map((r) => r.metrics?.cost ?? 0)), 3)} |`
      );
    }
    const models = [...new Set(configs.map((c) => c.model))];
    const skills = [...new Set(configs.map((c) => c.skills))];
    const harness = configs[0]?.harness;
    if (skills.length > 1) {
      lines.push(
        '',
        `**What skills change** (paired by task and repeat, against \`${skills[0]}\`):`,
        ''
      );
      for (const m of models) {
        for (const s of skills.slice(1)) {
          const d = pairedDelta(
            rs,
            { harness, model: m, skills: skills[0] },
            { harness, model: m, skills: s }
          );
          const t = pairedDelta(
            rs,
            { harness, model: m, skills: skills[0] },
            { harness, model: m, skills: s },
            'duration'
          );
          const c = pairedDelta(
            rs,
            { harness, model: m, skills: skills[0] },
            { harness, model: m, skills: s },
            'cost'
          );
          lines.push(
            `- ${m}, \`${s}\`: score ${signed(d.delta)}, time ${signed(t.delta, 0)} s, cost ${signed(c.delta, 3)} $ (n=${d.n})`
          );
        }
      }
    }
    if (models.length > 1) {
      lines.push('', `**What models change** (paired, against \`${models[0]}\`):`, '');
      for (const s of skills) {
        for (const m of models.slice(1)) {
          const d = pairedDelta(
            rs,
            { harness, model: models[0], skills: s },
            { harness, model: m, skills: s }
          );
          const t = pairedDelta(
            rs,
            { harness, model: models[0], skills: s },
            { harness, model: m, skills: s },
            'duration'
          );
          const c = pairedDelta(
            rs,
            { harness, model: models[0], skills: s },
            { harness, model: m, skills: s },
            'cost'
          );
          lines.push(
            `- \`${s}\`, ${m}: score ${signed(d.delta)}, time ${signed(t.delta, 0)} s, cost ${signed(c.delta, 3)} $ (n=${d.n})`
          );
        }
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}
