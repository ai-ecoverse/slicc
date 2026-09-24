/**
 * Run records → result files and a report. Pure.
 *
 * A run record is `{ benchmark, task_id, repeat, config: { harness, model, skills }, score,
 * verdict, outcome, metrics: { steps, duration, cost, tokens }, error? }`. Three kinds:
 * - errored (`error`): never finished running; reported, never counted as a failure, because
 *   #3180's matrix is sparse and an absent cell must not read as a fail;
 * - ran but not judged (`--no-judge`, no `score`): counts toward time and cost only;
 * - judged: has a numeric `score`, and is the only kind that enters scores and outcomes.
 *
 * Summaries keep browser-use's result-file fields (`run_start`, `tasks_completed`,
 * `tasks_successful`, `total_steps`, `total_duration`, `total_cost`) so SLICC's files sit
 * beside theirs, and add the rubric-score view.
 */

import { OUTCOMES, pathSegment } from './format.mjs';

export function configKey(c) {
  return `${c.model}|${c.skills}`;
}

/** The result-file name, in browser-use's `<Framework>_<version>_browser_<b>_model_<m>` style. */
export function summaryFileName(benchmark, config) {
  const safe = pathSegment;
  return `SLICC_${safe(config.harness)}_skills_${safe(config.skills)}_model_${safe(config.model)}_bench_${safe(benchmark)}.json`;
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const ran = (r) => !r.error || r.error_stage === 'judge';
const judged = (r) => !r.error && typeof r.score === 'number' && !Number.isNaN(r.score);

/**
 * The judge models behind the scored runs, read from the records themselves, so a report never
 * credits scores to a judge that did not produce them.
 */
export function judgeModels(records) {
  return [...new Set(records.filter(judged).map((r) => r.judge?.model ?? 'unknown'))].sort();
}
const round = (x, d = 4) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);

/** One summary per (benchmark, model, skills). */
export function summarize(records, { runStart } = {}) {
  const groups = new Map();
  for (const r of records) {
    const key = `${r.benchmark}|${configKey(r.config)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return [...groups.values()].map((rs) => {
    const done = rs.filter(ran);
    const scored = rs.filter(judged);
    const counts = Object.fromEntries(
      OUTCOMES.map((o) => [o, scored.filter((r) => r.outcome === o).length])
    );
    return {
      file: summaryFileName(rs[0].benchmark, rs[0].config),
      body: [
        {
          run_start: runStart ?? null,
          tasks_completed: scored.length,
          tasks_successful: scored.filter((r) => r.verdict).length,
          total_steps: done.reduce((a, r) => a + (r.metrics?.steps ?? 0), 0),
          total_duration: round(
            done.reduce((a, r) => a + (r.metrics?.duration ?? 0), 0),
            3
          ),
          total_cost: round(done.reduce((a, r) => a + (r.metrics?.cost ?? 0), 0)),
          benchmark: rs[0].benchmark,
          harness: rs[0].config.harness,
          model: rs[0].config.model,
          skills: rs[0].config.skills,
          judge_model: judgeModels(rs).join(', ') || null,
          mean_score: round(mean(scored.map((r) => r.score))),
          ...counts,
          not_judged: done.length - scored.length,
          errors: rs.length - done.length,
          runs: rs.map((r) => ({
            task_id: r.task_id,
            repeat: r.repeat,
            score: judged(r) ? round(r.score) : null,
            outcome: judged(r) ? r.outcome : null,
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
 * Mean difference of `b` over `a`, paired by task and repeat. Scores pair only runs both sides
 * judged; time and cost pair runs both sides finished. Pairing keeps an easy task that only one
 * side ran from moving the delta.
 */
export function pairedDelta(records, a, b, field = 'score') {
  const keep = field === 'score' ? judged : ran;
  const value = (r) => (field === 'score' ? r.score : (r.metrics?.[field] ?? 0));
  const index = (cfg) => {
    const m = new Map();
    for (const r of records) {
      if (keep(r) && configKey(r.config) === configKey(cfg))
        m.set(`${r.benchmark}|${r.task_id}|${r.repeat}`, r);
    }
    return m;
  };
  const ib = index(b);
  const diffs = [];
  for (const [k, ra] of index(a)) {
    const rb = ib.get(k);
    if (rb) diffs.push(value(rb) - value(ra));
  }
  return {
    n: diffs.length,
    delta: diffs.length ? diffs.reduce((x, y) => x + y, 0) / diffs.length : null,
  };
}

const fmt = (x, d = 2) => (x == null ? '–' : x.toFixed(d));
const signed = (x, d = 2) => (x == null ? '–' : `${x >= 0 ? '+' : ''}${x.toFixed(d)}`);

function deltaLine(label, records, from, to) {
  const d = pairedDelta(records, from, to);
  const t = pairedDelta(records, from, to, 'duration');
  const c = pairedDelta(records, from, to, 'cost');
  return `- ${label}: score ${signed(d.delta)}, time ${signed(t.delta, 0)} s, cost ${signed(c.delta, 3)} $ (n=${d.n})`;
}

function configRow(c, cs) {
  const done = cs.filter(ran);
  const scored = cs.filter(judged);
  const n = (o) => scored.filter((r) => r.outcome === o).length;
  return `| ${c.model} | ${c.skills} | ${cs.length} | ${n('pass')} | ${n('partial')} | ${n('fail')} | ${done.length - scored.length} | ${cs.length - done.length} | ${fmt(mean(scored.map((r) => r.score)))} | ${fmt(mean(done.map((r) => r.metrics?.duration ?? 0)), 0)} | ${fmt(mean(done.map((r) => r.metrics?.cost ?? 0)), 3)} |`;
}

/** Markdown for the job summary: one row per configuration, then skill and model deltas. */
export function reportMarkdown(records, { title = 'SLICC benchmark' } = {}) {
  const lines = [`## ${title}`, ''];
  const judges = judgeModels(records);
  if (judges.length)
    lines.push(
      `Judge: ${judges.map((m) => `\`${m}\``).join(', ')}. Scores are rubric fractions; pass = every item met.`,
      ''
    );
  const benchmarks = [...new Set(records.map((r) => r.benchmark))];
  for (const bench of benchmarks) {
    const rs = records.filter((r) => r.benchmark === bench);
    const configs = [...new Map(rs.map((r) => [configKey(r.config), r.config])).values()];
    lines.push(
      `### ${bench}`,
      '',
      '| model | skills | runs | pass | partial | fail | not judged | errors | mean score | mean s | mean $ |',
      '|---|---|---|---|---|---|---|---|---|---|---|'
    );
    for (const c of configs) {
      lines.push(
        configRow(
          c,
          rs.filter((r) => configKey(r.config) === configKey(c))
        )
      );
    }
    const models = [...new Set(configs.map((c) => c.model))];
    const skills = [...new Set(configs.map((c) => c.skills))];
    const harness = configs[0]?.harness;
    const cfg = (model, s) => ({ harness, model, skills: s });
    if (skills.length > 1) {
      lines.push(
        '',
        `**What skills change** (paired by task and repeat, against \`${skills[0]}\`):`,
        ''
      );
      for (const m of models) {
        for (const s of skills.slice(1)) {
          lines.push(deltaLine(`${m}, \`${s}\``, rs, cfg(m, skills[0]), cfg(m, s)));
        }
      }
    }
    if (models.length > 1) {
      lines.push('', `**What models change** (paired, against \`${models[0]}\`):`, '');
      for (const s of skills) {
        for (const m of models.slice(1)) {
          lines.push(deltaLine(`\`${s}\`, ${m}`, rs, cfg(models[0], s), cfg(m, s)));
        }
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}
