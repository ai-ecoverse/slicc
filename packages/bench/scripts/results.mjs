/**
 * Run records → result files and a report. Pure.
 *
 * A run record is `{ benchmark, task_id, repeat, config: { harness, model, skills, default_skills }, score,
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
import { canonicalModel, modelComparisons } from './models.mjs';

/** `none` / `none+…` — the condition that must not seed bundled skills. */
function isNoneSkills(skills) {
  return skills === 'none' || (typeof skills === 'string' && skills.startsWith('none+'));
}

/**
 * Grouping key for a run config. Pre-flag `none` records omit `default_skills` and must not
 * share a cell with post-flag `none` (`default_skills: false`). `new_session` other than erase
 * (or missing, which means erase) is a separate configuration so save/skip do not pool with it.
 */
export function configKey(c) {
  const model = canonicalModel(c.model);
  const session = c.new_session && c.new_session !== 'erase' ? `|session:${c.new_session}` : '';
  if (isNoneSkills(c.skills) && c.default_skills !== false && c.default_skills !== true) {
    return `${model}|${c.skills}|preflag${session}`;
  }
  return `${model}|${c.skills}${session}`;
}

/**
 * Records with `@default` folded into the plain model (`claude-opus-5-5@default` is
 * `claude-opus-5-5`: the bench sets no thinking level for either), so their runs pool into one
 * configuration with a larger N. Runs that now share a (config, task, repeat) are renumbered to
 * the next free repeat, in input order, so pairing and the task matrix keep every run.
 */
export function canonicalRecords(records) {
  const used = new Map();
  return records.map((r) => {
    const model = canonicalModel(r.config?.model);
    const key = `${r.benchmark}|${configKey({ ...r.config, model })}|${r.task_id}`;
    const taken = used.get(key) ?? new Set();
    used.set(key, taken);
    let repeat = r.repeat ?? 1;
    while (taken.has(repeat)) repeat += 1;
    taken.add(repeat);
    if (model === r.config?.model && repeat === r.repeat) return r;
    return { ...r, repeat, config: { ...r.config, model } };
  });
}

/** The result-file name, in browser-use's `<Framework>_<version>_browser_<b>_model_<m>` style. */
export function summaryFileName(benchmark, config) {
  const safe = pathSegment;
  let skills = safe(config.skills);
  // Keep the canonical `skills_none` name for post-flag runs; quarantine pre-flag `none`.
  if (
    isNoneSkills(config.skills) &&
    config.default_skills !== false &&
    config.default_skills !== true
  ) {
    skills = `${skills}_preflag`;
  }
  const session =
    config.new_session && config.new_session !== 'erase'
      ? `_session_${safe(config.new_session)}`
      : '';
  return `SLICC_${safe(config.harness)}_skills_${skills}_model_${safe(config.model)}${session}_bench_${safe(benchmark)}.json`;
}

/**
 * Runs per SLICC version their leader reported (`leader.slicc_version`), e.g. `{ '6.194.1': 7,
 * '6.194.2': 22 }`; `unknown` counts runs recorded without one. Versions drift with releases
 * during a run (see run.mjs `leaderStamp`), so a configuration can span several.
 */
export function versionCounts(rs) {
  const counts = {};
  for (const r of rs) {
    const v = r.leader?.slicc_version ?? 'unknown';
    counts[v] = (counts[v] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
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
          slicc_versions: versionCounts(rs),
          model: rs[0].config.model,
          skills: rs[0].config.skills,
          judge_model: judgeModels(rs).join(', ') || null,
          upstream: rs.find((r) => r.upstream)?.upstream ?? null,
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

/**
 * Tool use across finished runs whose transcript was counted: how many answered without a single
 * tool call, and the mean judged score of those against the runs that used tools.
 */
function toolStats(done) {
  const known = done.filter((r) => typeof r.metrics?.answered_without_tools === 'boolean');
  const bare = known.filter((r) => r.metrics.answered_without_tools);
  const tooled = known.filter((r) => !r.metrics.answered_without_tools);
  const score = (rs) => round(mean(rs.filter(judged).map((r) => r.score)));
  return {
    tool_known: known.length,
    no_tool_runs: bare.length,
    no_tool_rate: known.length ? round(bare.length / known.length) : null,
    no_tool_mean_score: score(bare),
    tool_mean_score: score(tooled),
  };
}

function configStats(c, cs) {
  const done = cs.filter(ran);
  const scored = cs.filter(judged);
  const n = (o) => scored.filter((r) => r.outcome === o).length;
  return {
    model: c.model,
    skills: c.skills,
    // erase (or missing) is the default; surface save/skip so memory arms label distinctly.
    new_session: c.new_session && c.new_session !== 'erase' ? c.new_session : 'erase',
    harness: c.harness ?? null,
    slicc_versions: versionCounts(cs),
    runs: cs.length,
    pass: n('pass'),
    partial: n('partial'),
    fail: n('fail'),
    not_judged: done.length - scored.length,
    errors: cs.length - done.length,
    mean_score: round(mean(scored.map((r) => r.score))),
    mean_duration: round(mean(knownValues(done, 'duration')), 3),
    mean_cost: round(mean(knownValues(done, 'cost'))),
    ...toolStats(done),
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
 * when `none` did not run) and model deltas (`kind`: `version`, `sibling`, `rung` or `effort`;
 * see `modelComparisons`). `@default` runs pool with the plain model (`canonicalRecords`).
 */
export function reportData(input) {
  const records = canonicalRecords(input);
  const benchmarks = [...new Set(records.map((r) => r.benchmark))].map((benchmark) => {
    const rs = records.filter((r) => r.benchmark === benchmark);
    const configs = [...new Map(rs.map((r) => [configKey(r.config), r.config])).values()];
    const models = [...new Set(configs.map((c) => c.model))];
    const skills = [...new Set(configs.map((c) => c.skills))];
    const harness = configs[0]?.harness;
    // Prefer the post-flag config when both pre-flag and real `none` are present.
    const cfg = (model, s) => {
      const hits = configs.filter((c) => c.model === model && c.skills === s);
      return (
        hits.find((c) => c.default_skills === false) ||
        hits.find((c) => c.default_skills === true) ||
        hits[0] || { harness, model, skills: s }
      );
    };
    const base = skillsBaseline(skills);
    // A lift needs a finished run in both conditions: a model that never ran the baseline, or
    // whose runs there all errored, gets no card, not an empty one (a sparse matrix runs `none`
    // for one model only). Judge-stage failures count: they keep their time and cost.
    const finished = (m, s) =>
      rs.some((r) => r.config.model === m && r.config.skills === s && ran(r));
    const skillDeltas = [];
    for (const m of models.filter((x) => finished(x, base))) {
      for (const s of skills.filter((x) => x !== base && finished(m, x))) {
        skillDeltas.push(delta(rs, cfg(m, base), cfg(m, s), { model: m, from: base, to: s }));
      }
    }
    // Each model against its older version, its sibling at the other provider, the next tier
    // up at its provider, and (for a thinking variant) the same model at its default.
    const modelDeltas = [];
    for (const s of skills) {
      const here = models.filter((m) => configs.some((c) => c.model === m && c.skills === s));
      for (const { kind, from, to } of modelComparisons(here)) {
        const d = delta(rs, cfg(from, s), cfg(to, s), { kind, skills: s, from, to });
        if (d.n > 0) modelDeltas.push(d);
      }
    }
    return {
      benchmark,
      upstream: rs.find((r) => r.upstream)?.upstream ?? null,
      slicc_versions: versionCounts(rs),
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

/** Model comparison kinds, in the order the report lists them, with their headings. */
export const COMPARISON_KINDS = [
  ['version', 'Against the older version'],
  ['sibling', 'Against the sibling at the other provider'],
  ['rung', 'One tier up at the same provider'],
  ['effort', 'Thinking effort, against the same model at its default'],
];

const fmt = (x, d = 2) => (x == null ? '–' : x.toFixed(d));
const signed = (x, d = 2) => (x == null ? '–' : `${x >= 0 ? '+' : ''}${x.toFixed(d)}`);
/** A relative change as a signed percentage: 0.129 → "+12.9%". */
export const percent = (x) => (x == null ? '–' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`);

function deltaLine(label, d) {
  return `- ${label}: score ${percent(d.score_pct)} (${fmt(d.score_from)} → ${fmt(d.score_to)}), time ${percent(d.duration_pct)} (${signed(d.duration, 0)} s), cost ${percent(d.cost_pct)} (${signed(d.cost, 3)} $) (n=${d.n})`;
}

/** Which SLICC versions ran, and a warning when runs span several. */
export function versionLine(counts) {
  const known = Object.entries(counts).filter(([v]) => v !== 'unknown');
  const unknown = counts.unknown ?? 0;
  const list = known.map(([v, n]) => `${v} (${n})`).join(', ');
  const tail = unknown ? `${list ? '; ' : ''}${unknown} run(s) without a recorded version` : '';
  if (known.length > 1)
    return `SLICC versions: ${list}${tail}. **Mixed:** releases shipped during the run, so these scores pool more than one harness.`;
  return `SLICC version: ${list || 'not recorded'}${known.length ? tail : ''}.`;
}

function sessionLabel(c) {
  return c.new_session && c.new_session !== 'erase' ? c.new_session : 'erase';
}

function configRow(c) {
  return `| ${c.model} | ${c.skills} | ${sessionLabel(c)} | ${c.runs} | ${c.pass} | ${c.partial} | ${c.fail} | ${c.not_judged} | ${c.errors} | ${fmt(c.mean_score)} | ${fmt(c.mean_duration, 0)} | ${fmt(c.mean_cost, 3)} |`;
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
      ...(b.upstream
        ? [
            '',
            `Tasks: ${b.upstream.repo} ${b.upstream.tag ?? ''} (${b.upstream.commit.slice(0, 7)}), \`${b.upstream.file}\` sha256 ${b.upstream.sha256.slice(0, 12)}`,
          ]
        : []),
      '',
      '| model | skills | new_session | runs | pass | partial | fail | not judged | errors | mean score | mean s | mean $ |',
      '|---|---|---|---|---|---|---|---|---|---|---|---|',
      ...b.configs.map(configRow),
      '',
      versionLine(b.slicc_versions)
    );
    const toolKnown = b.configs.filter((c) => c.tool_known);
    if (toolKnown.length) {
      lines.push(
        '',
        '**Answered without tools** (no tool call in the whole run: the agent answered from what it knew; of finished runs with a transcript):',
        '',
        ...toolKnown.map(
          (c) =>
            `- ${c.model}, \`${c.skills}\`, \`${sessionLabel(c)}\`: ${c.no_tool_runs}/${c.tool_known} (${(c.no_tool_rate * 100).toFixed(0)}%), mean score ${fmt(c.no_tool_mean_score)} without tools vs ${fmt(c.tool_mean_score)} with`
        )
      );
    }
    if (b.skill_deltas.length) {
      lines.push(
        '',
        `**What skills add** (lift over \`${b.skill_deltas[0].from}\`, paired by task and repeat):`,
        '',
        ...b.skill_deltas.map((d) => deltaLine(`${d.model}, \`${d.to}\``, d))
      );
    }
    for (const [kind, title] of COMPARISON_KINDS) {
      const ds = b.model_deltas.filter((d) => d.kind === kind);
      if (!ds.length) continue;
      lines.push(
        '',
        `**${title}** (paired by task and repeat):`,
        '',
        ...ds.map((d) => deltaLine(`\`${d.skills}\`, ${d.from} → ${d.to}`, d))
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}
