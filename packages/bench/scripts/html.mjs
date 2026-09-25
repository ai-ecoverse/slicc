#!/usr/bin/env node
/**
 * html — run records → one self-contained HTML page: a card per configuration, the report table
 * and paired deltas, a task × configuration score matrix, and time against cost per run.
 *
 *   node packages/bench/scripts/html.mjs --records <dir with records/> --out report.html
 *
 * `run.mjs` writes it as `report.html` beside report.md and report.json. `--records` also takes
 * a download of the dataset, or several runs' out dirs merged, to see configurations side by
 * side. Pure apart from the CLI: `reportHtml(records)` returns the page. It shows ids, scores and
 * metrics only, never task text, so it is safe for upstream sets.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chartLegend, modelSlots, rankingChart, valueChart } from './charts.mjs';
import { listFiles } from './publish.mjs';
import { configKey, percent, reportData } from './results.mjs';

const esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

const num = (x, d = 2) => (x == null || Number.isNaN(x) ? '–' : x.toFixed(d));
const signed = (x, d = 2) => (x == null ? '–' : `${x >= 0 ? '+' : ''}${x.toFixed(d)}`);
const judged = (r) => !r.error && typeof r.score === 'number';

/** A run's cell state: pass / partial / fail from its outcome, else error or not judged. */
export function cellState(r) {
  if (!r) return 'missing';
  if (r.error && r.error_stage !== 'judge') return 'error';
  if (!judged(r)) return 'unjudged';
  return r.outcome ?? (r.score >= 1 ? 'pass' : r.score > 0 ? 'partial' : 'fail');
}

/** Long ids (upstream UUIDs) shortened to their first 8 characters; short ones kept whole. */
export const shortId = (id) => (String(id).length > 12 ? String(id).slice(0, 8) : String(id));

const configLabel = (c) => `${c.model} · ${c.skills}`;

function outcomeBar(c) {
  const total = c.runs || 1;
  const seg = (n, cls, label) =>
    n ? `<span class="seg ${cls}" style="flex:${n}" title="${esc(label)}: ${n}"></span>` : '';
  return `<div class="bar" role="img" aria-label="${c.pass} pass, ${c.partial} partial, ${c.fail} fail, ${c.not_judged} not judged, ${c.errors} errors of ${total}">${seg(c.pass, 'pass', 'pass')}${seg(c.partial, 'partial', 'partial')}${seg(c.fail, 'fail', 'fail')}${seg(c.not_judged, 'unjudged', 'not judged')}${seg(c.errors, 'error', 'errors')}</div>`;
}

function card(c) {
  return `<article class="card">
  <h3>${esc(c.model)} <span class="chip">${esc(c.skills)}</span></h3>
  <p class="big">${num(c.mean_score)}<small> mean score</small></p>
  ${outcomeBar(c)}
  <dl>
    <dt>runs</dt><dd>${c.runs}</dd>
    <dt>pass / partial / fail</dt><dd>${c.pass} / ${c.partial} / ${c.fail}</dd>
    <dt>not judged / errors</dt><dd>${c.not_judged} / ${c.errors}</dd>
    <dt>mean time</dt><dd>${num(c.mean_duration, 0)} s</dd>
    <dt>mean cost</dt><dd>$${num(c.mean_cost, 3)}</dd>
  </dl>
</article>`;
}

function configTable(b) {
  const rows = b.configs
    .map(
      (c) =>
        `<tr><td>${esc(c.model)}</td><td>${esc(c.skills)}</td><td>${c.runs}</td><td>${c.pass}</td><td>${c.partial}</td><td>${c.fail}</td><td>${c.not_judged}</td><td>${c.errors}</td><td>${num(c.mean_score)}</td><td>${num(c.mean_duration, 0)}</td><td>${num(c.mean_cost, 3)}</td></tr>`
    )
    .join('\n');
  return `<div class="scroll"><table class="configs"><thead><tr><th>model</th><th>skills</th><th>runs</th><th>pass</th><th>partial</th><th>fail</th><th>not judged</th><th>errors</th><th>mean score</th><th>mean s</th><th>mean $</th></tr></thead><tbody>
${rows}
</tbody></table></div>`;
}

function deltaList(title, deltas, label) {
  if (!deltas.length) return '';
  const items = deltas
    .map((d) => {
      const tone = d.score == null ? '' : d.score > 0 ? 'up' : d.score < 0 ? 'down' : '';
      return `<li><strong>${esc(label(d))}</strong>: score <span class="${tone}">${percent(d.score_pct)}</span> <span class="muted">(${num(d.score_from)} → ${num(d.score_to)})</span>, time ${tradeoff(d.duration, d.duration_pct, 'time')}, cost ${tradeoff(d.cost, d.cost_pct, 'cost')} <span class="muted">(n=${d.n})</span></li>`;
    })
    .join('\n');
  return `<h3>${esc(title)}</h3><ul class="deltas">${items}</ul>`;
}

/** Below this many paired tasks, a lift is flagged as a small sample. */
export const SMALL_SAMPLE = 10;

/**
 * A paired time or cost difference in words, relative first: "22% faster (71 s)",
 * "11% cheaper ($0.035)". Without a relative change (a zero baseline), the absolute one alone.
 */
export function tradeoff(value, pct, kind) {
  if (value == null || Number.isNaN(value)) return '–';
  const abs = Math.abs(value);
  const amount = kind === 'time' ? `${abs.toFixed(0)} s` : `$${abs.toFixed(3)}`;
  if (amount === '0 s' || amount === '$0.000') return 'about the same';
  const [less, more] = kind === 'time' ? ['faster', 'slower'] : ['cheaper', 'more expensive'];
  const word = value < 0 ? less : more;
  const head = pct == null ? `${amount} ${word}` : `${Math.abs(pct * 100).toFixed(0)}% ${word}`;
  const tail = pct == null ? '' : ` <span class="muted">(${amount})</span>`;
  return value < 0 ? `<span class="up">${head}</span>${tail}` : `${head}${tail}`;
}

/** Paired mean score without and with, on a 0–1 track. */
function dumbbell(from, to) {
  if (from == null || to == null) return '';
  const W = 240;
  const P = 8;
  const x = (v) => (P + v * (W - 2 * P)).toFixed(1);
  const tone = to > from ? 'up' : to < from ? 'down' : 'flat';
  return `<svg class="dumbbell ${tone}" viewBox="0 0 ${W} 20" role="img" aria-label="mean score ${num(from)} without, ${num(to)} with">
  <line x1="${P}" y1="10" x2="${W - P}" y2="10" class="track"/>
  <line x1="${x(from)}" y1="10" x2="${x(to)}" y2="10" class="span"/>
  <circle cx="${x(from)}" cy="10" r="5" class="from"/>
  <circle cx="${x(to)}" cy="10" r="6" class="to"/>
</svg>`;
}

function liftCard(d) {
  const tone = d.score == null ? '' : d.score > 0 ? 'up' : d.score < 0 ? 'down' : '';
  const small = d.n < SMALL_SAMPLE ? ' <span class="chip warn">small sample</span>' : '';
  return `<article class="card lift">
  <h3>${esc(d.model)} <span class="chip">${esc(d.to)} over ${esc(d.from)}</span></h3>
  <p class="big ${tone}">${percent(d.score_pct)}<small> score lift</small></p>
  ${dumbbell(d.score_from, d.score_to)}
  <p class="pair">${esc(d.from)} ${num(d.score_from)} → ${esc(d.to)} ${num(d.score_to)} (${signed(d.score)})</p>
  <dl>
    <dt>time</dt><dd>${tradeoff(d.duration, d.duration_pct, 'time')}</dd>
    <dt>cost</dt><dd>${tradeoff(d.cost, d.cost_pct, 'cost')}</dd>
    <dt>paired tasks</dt><dd>${d.n}${small}</dd>
  </dl>
</article>`;
}

/**
 * What the skills add: per model, the paired mean score without and with, its lift, and what it
 * does to time and cost. Measured over tasks both sides judged, so an easy task only one side
 * finished cannot move it.
 */
function skillLift(b) {
  if (!b.skill_deltas.length) return '';
  const base = b.skill_deltas[0].from;
  return `<h3>Skills lift <small>relative to ${esc(base)}; paired by task, counting only tasks both sides judged</small></h3>
<div class="cards">${b.skill_deltas.map(liftCard).join('\n')}</div>`;
}

/** Task × configuration grid, hardest tasks (lowest mean score) first. */
function matrix(records, configs) {
  const byTask = new Map();
  for (const r of records) {
    if (!byTask.has(r.task_id)) byTask.set(r.task_id, new Map());
    byTask.get(r.task_id).set(`${configKey(r.config)}|${r.repeat}`, r);
  }
  const repeats = [...new Set(records.map((r) => r.repeat))].sort((a, b) => a - b);
  const cols = configs.flatMap((c) => repeats.map((rep) => ({ c, rep })));
  const meanOf = (runs) => {
    const s = [...runs.values()].filter(judged).map((r) => r.score);
    return s.length ? s.reduce((a, b) => a + b, 0) / s.length : -1;
  };
  const tasks = [...byTask.entries()].sort(
    (a, b) => meanOf(a[1]) - meanOf(b[1]) || a[0].localeCompare(b[0])
  );
  const head = cols
    .map(
      ({ c, rep }) =>
        `<th scope="col">${esc(configLabel(c))}${repeats.length > 1 ? ` r${rep}` : ''}</th>`
    )
    .join('');
  const body = tasks
    .map(([id, runs]) => {
      const cells = cols
        .map(({ c, rep }) => {
          const r = runs.get(`${configKey(c)}|${rep}`);
          const state = cellState(r);
          if (!r) return '<td class="cell missing" title="not run">·</td>';
          const tip = [
            state,
            judged(r) ? `score ${num(r.score)}` : r.error ? `error: ${r.error}` : 'not judged',
            `${num(r.metrics?.duration, 0)} s`,
            `$${num(r.metrics?.cost, 3)}`,
          ].join(' · ');
          const text = judged(r) ? num(r.score) : state === 'error' ? 'err' : '?';
          return `<td class="cell ${state}" title="${esc(tip)}">${text}</td>`;
        })
        .join('');
      return `<tr><th scope="row" title="${esc(id)}"><code>${esc(shortId(id))}</code></th>${cells}</tr>`;
    })
    .join('\n');
  return `<div class="scroll"><table class="matrix"><thead><tr><th scope="col">task</th>${head}</tr></thead><tbody>
${body}
</tbody></table></div>`;
}

/**
 * Time (x) against cost (y), one dot per finished run whose time and cost were both measured,
 * colored by model and outlined without skills. A run with an unknown cost is left out, not
 * drawn at $0.
 */
function scatter(records, slots) {
  const measured = (r) =>
    typeof r.metrics?.duration === 'number' && typeof r.metrics?.cost === 'number';
  const runs = records.filter((r) => (!r.error || r.error_stage === 'judge') && measured(r));
  if (!runs.length) return '<p class="muted">No finished runs with a measured time and cost.</p>';
  const W = 640;
  const H = 320;
  const P = 44;
  const maxX = Math.max(...runs.map((r) => r.metrics?.duration ?? 0), 1);
  const maxY = Math.max(...runs.map((r) => r.metrics?.cost ?? 0), 0.001);
  const x = (v) => P + (v / maxX) * (W - P * 1.5);
  const y = (v) => H - P - (v / maxY) * (H - P * 1.5);
  const dots = runs
    .map((r) => {
      const state = cellState(r);
      const tip = `${configLabel(r.config)} · ${r.task_id} · ${state} · ${num(r.metrics?.duration, 0)} s · $${num(r.metrics?.cost, 3)}`;
      const kind = r.config.skills === 'none' ? 'without' : 'with';
      return `<circle cx="${x(r.metrics?.duration ?? 0).toFixed(1)}" cy="${y(r.metrics?.cost ?? 0).toFixed(1)}" r="5" class="mark ${kind}" style="--c: var(--series-${slots.get(r.config.model)})"><title>${esc(tip)}</title></circle>`;
    })
    .join('\n');
  return `${chartLegend(slots)}
<svg viewBox="0 0 ${W} ${H}" class="scatter" role="img" aria-label="Time against cost per run">
  <line x1="${P}" y1="${H - P}" x2="${W - P / 2}" y2="${H - P}" class="axis"/>
  <line x1="${P}" y1="${P / 2}" x2="${P}" y2="${H - P}" class="axis"/>
  <text x="${W - P / 2}" y="${H - P + 28}" text-anchor="end" class="label">time, s (max ${num(maxX, 0)})</text>
  <text x="${P - 8}" y="${P / 2 + 4}" text-anchor="end" class="label">$${num(maxY, 2)}</text>
  <text x="${P - 8}" y="${H - P + 4}" text-anchor="end" class="label">0</text>
${dots}
</svg>`;
}

const STYLE = `
:root { color-scheme: light dark; --bg:#fff; --fg:#1b1f24; --muted:#5f6b7a; --line:#d8dee4; --card:#f6f8fa;
  --pass:#2b8a3e; --partial:#e8a200; --fail:#d6336c; --error:#868e96; --unjudged:#adb5bd;
  --series-1:#2a78d6; --series-2:#eb6834; --series-3:#1baf7a; --series-4:#eda100;
  --series-5:#e87ba4; --series-6:#008300; --series-7:#4a3aa7; --series-8:#e34948; }
@media (prefers-color-scheme: dark) { :root { --bg:#0f1216; --fg:#e6e9ee; --muted:#9aa5b1; --line:#2d333b;
  --card:#171b21; --pass:#51cf66; --partial:#fcc419; --fail:#ff6b8b; --error:#868e96; --unjudged:#5c636b;
  --series-1:#3987e5; --series-2:#d95926; --series-3:#199e70; --series-4:#c98500;
  --series-5:#d55181; --series-6:#008300; --series-7:#9085e9; --series-8:#e66767; } }
* { box-sizing: border-box; }
body { margin: 0 auto; max-width: 1200px; padding: 24px; background: var(--bg); color: var(--fg);
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
h1 { margin: 0 0 4px; font-size: 26px; } h2 { margin: 36px 0 12px; font-size: 20px; }
h3 { margin: 18px 0 8px; font-size: 16px; }
.muted, small { color: var(--muted); }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 12px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 14px; min-width: 0; }
.card h3 { margin: 0 0 6px; font-size: 15px; overflow-wrap: anywhere; }
.chip { font-size: 12px; font-weight: 500; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); }
.big { font-size: 30px; font-weight: 650; margin: 2px 0 8px; } .big small { font-size: 13px; font-weight: 400; }
dl { display: grid; grid-template-columns: auto auto; gap: 2px 12px; margin: 10px 0 0; font-size: 13px; }
dt { color: var(--muted); } dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
.bar { display: flex; height: 10px; border-radius: 5px; overflow: hidden; background: var(--line); }
.seg.pass, .cell.pass { background: var(--pass); } .seg.partial, .cell.partial { background: var(--partial); }
.seg.fail, .cell.fail { background: var(--fail); } .seg.error, .cell.error { background: var(--error); }
.seg.unjudged, .cell.unjudged { background: var(--unjudged); }
table { border-collapse: collapse; font-variant-numeric: tabular-nums; }
.configs { width: 100%; white-space: nowrap; } .configs th, .configs td { padding: 6px 10px; border-bottom: 1px solid var(--line); text-align: right; }
.configs th:nth-child(-n+2), .configs td:nth-child(-n+2) { text-align: left; }
.scroll { overflow-x: auto; }
.matrix th, .matrix td { padding: 3px 6px; font-size: 12px; text-align: center; }
.matrix thead th { writing-mode: vertical-rl; transform: rotate(180deg); white-space: nowrap; font-weight: 500; }
.matrix tbody th { text-align: left; font-weight: 400; }
.cell { min-width: 44px; color: #fff; border: 2px solid var(--bg); border-radius: 6px; }
.cell.partial { color: #1b1f24; } .cell.missing { color: var(--muted); background: transparent; }
.big.up { color: var(--pass); } .big.down { color: var(--fail); }
.chip.warn { border-color: var(--partial); }
.dumbbell { display: block; width: 100%; height: auto; margin: 6px 0 2px; }
.dumbbell .track { stroke: var(--line); stroke-width: 2; }
.dumbbell .span { stroke-width: 4; stroke-linecap: round; }
.dumbbell .from { fill: var(--bg); stroke: var(--muted); stroke-width: 2; }
.dumbbell.up .span { stroke: var(--pass); } .dumbbell.up .to { fill: var(--pass); }
.dumbbell.down .span { stroke: var(--fail); } .dumbbell.down .to { fill: var(--fail); }
.dumbbell.flat .span { stroke: var(--muted); } .dumbbell.flat .to { fill: var(--muted); }
.pair { margin: 0; font-size: 12px; color: var(--muted); }
.deltas li { margin: 3px 0; } .up { color: var(--pass); font-weight: 600; } .down { color: var(--fail); font-weight: 600; }
.scatter { width: 100%; max-width: 760px; height: auto; } .axis { stroke: var(--muted); }
.value { width: 100%; max-width: 900px; height: auto; } .ranking { max-width: 100%; height: auto; }
.label { fill: var(--muted); font-size: 12px; }
.mark { fill: var(--c); stroke: var(--c); }
.mark.with { stroke: var(--bg); stroke-width: 2; }
.mark.without { fill-opacity: .18; stroke-width: 2; }
.grid { stroke: var(--line); stroke-dasharray: 3 3; }
.bar-value { fill: var(--fg); font-size: 14px; font-weight: 650; }
.tick-name, .point-label { fill: var(--fg); font-size: 12px; }
.axis-title { fill: var(--muted); font-size: 12px; }
.quad-good { fill: var(--pass); fill-opacity: .1; } .quad-rest { fill: var(--muted); fill-opacity: .06; }
.quad-label { fill: var(--pass); font-size: 12px; font-weight: 600; }
.pareto { fill: none; stroke: var(--fg); stroke-width: 2; stroke-dasharray: 1 5; stroke-linecap: round; }
.legend { list-style: none; display: flex; flex-wrap: wrap; gap: 6px 16px; padding: 0; margin: 6px 0; font-size: 13px; }
.swatch { display: inline-block; width: 11px; height: 11px; border-radius: 50%; margin-right: 6px; vertical-align: -1px; }
.swatch.series { background: var(--c); }
.swatch.outline { border: 2px solid var(--muted); }
.swatch.quad { border-radius: 2px; background: color-mix(in srgb, var(--pass) 18%, transparent); }
.swatch.pareto-key { width: 18px; height: 0; border-radius: 0; border-top: 2px dotted var(--fg); vertical-align: 3px; }
footer { margin-top: 40px; font-size: 13px; color: var(--muted); }
`;

/** The page for a set of records. */
export function reportHtml(
  records,
  { title = 'SLICC Bench', generated = new Date().toISOString() } = {}
) {
  const data = reportData(records);
  const judges = data.judges.length
    ? data.judges.map((j) => `<code>${esc(j)}</code>`).join(', ')
    : 'none yet';
  const sections = data.benchmarks
    .map((b) => {
      const rs = records.filter((r) => r.benchmark === b.benchmark);
      const configs = b.configs.map((c) => ({
        harness: c.harness,
        model: c.model,
        skills: c.skills,
      }));
      const slots = modelSlots(b.configs.map((c) => c.model));
      return `<section>
<h2>${esc(b.benchmark)} <small>${rs.length} runs, ${new Set(rs.map((r) => r.task_id)).size} tasks</small></h2>
<h3>Ranking <small>score = mean rubric score × 100, over judged runs</small></h3>
${chartLegend(slots)}
${rankingChart(b.configs, slots)}
<h3>Score vs. cost per task <small>mean cost of the runs that finished</small></h3>
${valueChart(b.configs, slots)}
${skillLift(b)}
<h3>Configurations</h3>
<div class="cards">${b.configs.map(card).join('\n')}</div>
${configTable(b)}
${deltaList(`What models change (paired, against ${b.model_deltas[0]?.from ?? ''})`, b.model_deltas, (d) => `${d.skills}, ${d.to}`)}
<h3>Tasks <small>hardest first; hover a cell for time and cost</small></h3>
${matrix(rs, configs)}
<h3>Time and cost per run</h3>
${scatter(rs, slots)}
</section>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<header>
<h1>${esc(title)}</h1>
<p class="muted">Judge: ${judges}. Scores are rubric fractions: 1 is a pass, above 0 partial, 0 a fail. Errors are listed, never counted as fails. Generated ${esc(generated)}.</p>
</header>
${sections || '<p class="muted">No runs yet.</p>'}
<footer>Task text is never shown: browser-use's sets and SLICC's own are published encrypted. Data: <a href="https://huggingface.co/datasets/ai-ecoverse/slicc-bench">ai-ecoverse/slicc-bench</a>.</footer>
</body>
</html>
`;
}

/** Every record under `<dir>/records/`; none when it is missing. */
export function readRecordsDir(dir) {
  const root = join(dir, 'records');
  return listFiles(root)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(root, f), 'utf8')));
}

export function main(argv = process.argv.slice(2), { log = console.error } = {}) {
  const { values } = parseArgs({
    args: argv,
    options: { records: { type: 'string' }, out: { type: 'string' }, title: { type: 'string' } },
  });
  if (!values.records || !values.out) throw new Error('give --records <dir> and --out <file.html>');
  const records = readRecordsDir(resolve(values.records));
  writeFileSync(
    resolve(values.out),
    reportHtml(records, values.title ? { title: values.title } : {})
  );
  log(`wrote ${values.out} from ${records.length} record(s)`);
  return 0;
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
/* v8 ignore next 8 */
if (isMain) {
  try {
    process.exit(main());
  } catch (err) {
    console.error(`html: ${err.message}`);
    process.exit(1);
  }
}
