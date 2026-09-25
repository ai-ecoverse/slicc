import { OUTCOMES, pathSegment } from './format.mjs';

export function configKey(c) {
  return `${c.model}|${c.skills}`;
}

export function summaryFileName(benchmark, config) {
  const safe = pathSegment;
  return `SLICC_${safe(config.harness)}_skills_${safe(config.skills)}_model_${safe(config.model)}_bench_${safe(benchmark)}.json`;
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const ran = (r) => !r.error || r.error_stage === 'judge';
const judged = (r) => !r.error && typeof r.score === 'number' && !Number.isNaN(r.score);

export function judgeModels(records) {
  return [...new Set(records.filter(judged).map((r) => r.judge?.model ?? 'unknown'))].sort();
}

const known = (r, field) => (typeof r.metrics?.[field] === 'number' ? r.metrics[field] : null);
const knownValues = (rs, field) => rs.map((r) => known(r, field)).filter((v) => v !== null);

const round = (x, d = 4) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);

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
  const diffs = [];
  for (const [k, ra] of index(a)) {
    const rb = ib.get(k);
    if (rb && value(ra) !== null && value(rb) !== null) diffs.push(value(rb) - value(ra));
  }
  return {
    n: diffs.length,
    delta: diffs.length ? diffs.reduce((x, y) => x + y, 0) / diffs.length : null,
  };
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

function delta(records, from, to, extra) {
  const d = pairedDelta(records, from, to);
  const t = pairedDelta(records, from, to, 'duration');
  const c = pairedDelta(records, from, to, 'cost');
  return {
    ...extra,
    score: round(d.delta),
    duration: round(t.delta, 3),
    cost: round(c.delta),
    n: d.n,
  };
}

export function reportData(records) {
  const benchmarks = [...new Set(records.map((r) => r.benchmark))].map((benchmark) => {
    const rs = records.filter((r) => r.benchmark === benchmark);
    const configs = [...new Map(rs.map((r) => [configKey(r.config), r.config])).values()];
    const models = [...new Set(configs.map((c) => c.model))];
    const skills = [...new Set(configs.map((c) => c.skills))];
    const harness = configs[0]?.harness;
    const cfg = (model, s) => ({ harness, model, skills: s });
    const skillDeltas = [];
    for (const m of models) {
      for (const s of skills.slice(1)) {
        skillDeltas.push(
          delta(rs, cfg(m, skills[0]), cfg(m, s), { model: m, from: skills[0], to: s })
        );
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

function deltaLine(label, d) {
  return `- ${label}: score ${signed(d.score)}, time ${signed(d.duration, 0)} s, cost ${signed(d.cost, 3)} $ (n=${d.n})`;
}

function configRow(c) {
  return `| ${c.model} | ${c.skills} | ${c.runs} | ${c.pass} | ${c.partial} | ${c.fail} | ${c.not_judged} | ${c.errors} | ${fmt(c.mean_score)} | ${fmt(c.mean_duration, 0)} | ${fmt(c.mean_cost, 3)} |`;
}

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
        `**What skills change** (paired by task and repeat, against \`${b.skill_deltas[0].from}\`):`,
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
