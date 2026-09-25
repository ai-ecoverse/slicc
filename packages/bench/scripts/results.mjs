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
/** A metric when it was measured: a failed reading is null, and must not average in as 0. */
const known = (r, field) => (typeof r.metrics?.[field] === 'number' ? r.metrics[field] : null);
const knownValues = (rs, field) => rs.map((r) => known(r, field)).filter((v) => v !== null);

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
          total_cost: round(knownValues(done, 'cost').reduce((a, b) => a + b, 0)),
          cost_unknown: done.length - knownValues(done, 'cost').length,
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
 * Mean difference of `b` over `a`, paired by task and repeat, with each side's mean over the same
 * pairs (`from`, `to`). Scores pair only runs both sides judged; time and cost pair runs both
 * sides finished and measured. Pairing keeps an easy task that only one side ran from moving the
 * delta.
 */
export function pairedDelta(records, a, b, field = 'score') {
  const keep = field === 'score' ? judged : ran;
  const value = (r) => (field === 'score' ? r.score : known(r, field));
  const index = (cfg) => {
    const m = new Map();
    for (const r of records) {
      if (keep(r) && configKey(r.config) === configKey(cfg))
        m.set(`${r.benchmark}|${r.task_id}|${r.repeat}`, r);
    }
    return m;
  };
  const ib = index(b);
  const pairs = [];
  for (const [k, ra] of index(a)) {
    const rb = ib.get(k);
    if (rb && value(ra) !== null && value(rb) !== null) pairs.push([value(ra), value(rb)]);
  }
  return {
    n: pairs.length,
    delta: mean(pairs.map(([x, y]) => y - x)),
    from: mean(pairs.map(([x]) => x)),
    to: mean(pairs.map(([, y]) => y)),
  };
}

/**
 * The skills condition the others are measured against: `none` when it ran, so a delta reads as
 * the lift the skills give; otherwise the first condition.
 */
export function skillsBaseline(skills) {
  return skills.includes('none') ? 'none' : skills[0];
}

function configStats(c, cs) {
  const done = cs.filter(ran);
  const scored = cs.filter(judged);
  const n = (o) => scored.filter((r) => r.outcome === o).length;
  return {
    model: c.model,
    skills: c.skills,
    harness: c.harness ?? null,
    runs: cs.length,
    pass: n('pass'),
    partial: n('partial'),
    fail: n('fail'),
    not_judged: done.length - scored.length,
    errors: cs.length - done.length,
    mean_score: round(mean(scored.map((r) => r.score))),
    mean_duration: round(mean(knownValues(done, 'duration')), 3),
    mean_cost: round(mean(knownValues(done, 'cost'))),
  };
}

/** A paired change relative to its baseline mean; null when the baseline is zero or unknown. */
export function relative(p) {
  return p.from ? round(p.delta / p.from) : null;
}

function delta(records, from, to, extra) {
  const d = pairedDelta(records, from, to);
  const t = pairedDelta(records, from, to, 'duration');
  const c = pairedDelta(records, from, to, 'cost');
  return {
    ...extra,
    score: round(d.delta),
    score_pct: relative(d),
    score_from: round(d.from),
    score_to: round(d.to),
    duration: round(t.delta, 3),
    duration_pct: relative(t),
    cost: round(c.delta),
    cost_pct: relative(c),
    n: d.n,
  };
}

/**
 * The report as data, the source of both report.md and report.json: per benchmark, one row per
 * configuration, then paired skill deltas (the lift over `none`, or over the first condition
 * when `none` did not run) and model deltas (against the first model).
 */
export function reportData(records) {
  const benchmarks = [...new Set(records.map((r) => r.benchmark))].map((benchmark) => {
    const rs = records.filter((r) => r.benchmark === benchmark);
    const configs = [...new Map(rs.map((r) => [configKey(r.config), r.config])).values()];
    const models = [...new Set(configs.map((c) => c.model))];
    const skills = [...new Set(configs.map((c) => c.skills))];
    const harness = configs[0]?.harness;
    const cfg = (model, s) => ({ harness, model, skills: s });
    const base = skillsBaseline(skills);
    const skillDeltas = [];
    for (const m of models) {
      for (const s of skills.filter((x) => x !== base)) {
        skillDeltas.push(delta(rs, cfg(m, base), cfg(m, s), { model: m, from: base, to: s }));
      }
    }
    const modelDeltas = [];
    for (const s of skills) {
      for (const m of models.slice(1)) {
        modelDeltas.push(
          delta(rs, cfg(models[0], s), cfg(m, s), { skills: s, from: models[0], to: m })
        );
      }
    }
    return {
      benchmark,
      configs: configs.map((c) =>
        configStats(
          c,
          rs.filter((r) => configKey(r.config) === configKey(c))
        )
      ),
      skill_deltas: skillDeltas,
      model_deltas: modelDeltas,
    };
  });
  return { judges: judgeModels(records), benchmarks };
}

const fmt = (x, d = 2) => (x == null ? '–' : x.toFixed(d));
const signed = (x, d = 2) => (x == null ? '–' : `${x >= 0 ? '+' : ''}${x.toFixed(d)}`);
/** A relative change as a signed percentage: 0.129 → "+12.9%". */
export const percent = (x) => (x == null ? '–' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`);

function deltaLine(label, d) {
  return `- ${label}: score ${percent(d.score_pct)} (${fmt(d.score_from)} → ${fmt(d.score_to)}), time ${percent(d.duration_pct)} (${signed(d.duration, 0)} s), cost ${percent(d.cost_pct)} (${signed(d.cost, 3)} $) (n=${d.n})`;
}

function configRow(c) {
  return `| ${c.model} | ${c.skills} | ${c.runs} | ${c.pass} | ${c.partial} | ${c.fail} | ${c.not_judged} | ${c.errors} | ${fmt(c.mean_score)} | ${fmt(c.mean_duration, 0)} | ${fmt(c.mean_cost, 3)} |`;
}

/** Markdown for the job summary: one row per configuration, then skill and model deltas. */
export function reportMarkdown(records, { title = 'SLICC benchmark' } = {}) {
  const data = reportData(records);
  const lines = [`## ${title}`, ''];
  if (data.judges.length)
    lines.push(
      `Judge: ${data.judges.map((m) => `\`${m}\``).join(', ')}. Scores are rubric fractions; pass = every item met.`,
      ''
    );
  for (const b of data.benchmarks) {
    lines.push(
      `### ${b.benchmark}`,
      '',
      '| model | skills | runs | pass | partial | fail | not judged | errors | mean score | mean s | mean $ |',
      '|---|---|---|---|---|---|---|---|---|---|---|',
      ...b.configs.map(configRow)
    );
    if (b.skill_deltas.length) {
      lines.push(
        '',
        `**What skills add** (lift over \`${b.skill_deltas[0].from}\`, paired by task and repeat):`,
        '',
        ...b.skill_deltas.map((d) => deltaLine(`${d.model}, \`${d.to}\``, d))
      );
    }
    if (b.model_deltas.length) {
      lines.push(
        '',
        `**What models change** (paired, against \`${b.model_deltas[0].from}\`):`,
        '',
        ...b.model_deltas.map((d) => deltaLine(`\`${d.skills}\`, ${d.to}`, d))
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}
