/**
 * The report's headline charts, after Artificial Analysis' Intelligence Index charts:
 * - `rankingChart`: configurations ranked by score, one bar each;
 * - `valueChart`: score against cost per task (log scale), with the most attractive quadrant
 *   (cheaper and better than the median configuration) and the Pareto line.
 *
 * Pure: configuration stats (`reportData().benchmarks[].configs`) in, SVG strings out. Color
 * follows the model (`--series-N`, which the page defines for light and dark); the skills
 * condition is the fill: `none` is outlined, any skills solid. Every mark has a tooltip; bars and
 * the value chart's Pareto points also carry a direct label, the value chart's other points
 * show theirs on hover, so a crowded chart stays legible and identity never rests on color alone.
 */

const esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

/** Categorical slots the page defines (`--series-1` … `--series-8`). */
export const SERIES_SLOTS = 12;

/** Model → categorical slot, alphabetical, so a model keeps its color from report to report. */
export function modelSlots(models) {
  return new Map([...new Set(models)].sort().map((m, i) => [m, (i % SERIES_SLOTS) + 1]));
}

/** A configuration's score on a 0–100 index: its mean rubric score × 100. */
export const indexScore = (c) => (c.mean_score == null ? null : c.mean_score * 100);

const withSkills = (c) => c.skills !== 'none';
const fill = (c, slots) =>
  `class="mark ${withSkills(c) ? 'with' : 'without'}" style="--c: var(--series-${slots.get(c.model)})"`;

/** The model swatches and the skills encoding, one row above a chart. */
export function chartLegend(slots, extra = '') {
  const models = [...slots.entries()]
    .map(
      ([m, s]) =>
        `<li><span class="swatch series" style="--c: var(--series-${s})"></span>${esc(m)}</li>`
    )
    .join('');
  return `<ul class="legend">${extra}${models}<li><span class="swatch series" style="--c: var(--muted)"></span>solid: with skills</li><li><span class="swatch outline"></span>outlined: without skills</li></ul>`;
}

/** A bar whose top corners are rounded and whose base sits on the axis. */
function barPath(x, top, w, base, r = 4) {
  const rr = Math.min(r, (base - top) / 2, w / 2);
  if (rr <= 0) return `M${x},${base}H${x + w}Z`;
  return `M${x},${base}V${top + rr}Q${x},${top} ${x + rr},${top}H${x + w - rr}Q${x + w},${top} ${x + w},${top + rr}V${base}Z`;
}

/** Configurations ranked by score, best first: one bar each, value on top, name below. */
export function rankingChart(configs, slots) {
  const rows = configs
    .filter((c) => c.mean_score != null)
    .sort((a, b) => b.mean_score - a.mean_score || a.model.localeCompare(b.model));
  if (!rows.length) return '<p class="muted">No judged runs yet.</p>';
  const barW = 96;
  const gap = 18;
  const left = 34;
  const top = 26;
  const plotH = 200;
  const base = top + plotH;
  const W = left + rows.length * (barW + gap);
  const H = base + 46;
  const y = (v) => base - (plotH * v) / 100;
  const grid = [0, 25, 50, 75, 100]
    .map(
      (v) =>
        `<line x1="${left}" x2="${W}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${left - 6}" y="${y(v) + 4}" text-anchor="end" class="label">${v}</text>`
    )
    .join('');
  const bars = rows
    .map((c, i) => {
      const x = left + gap / 2 + i * (barW + gap);
      const v = indexScore(c);
      const cx = x + barW / 2;
      const tip = `${c.model} · ${c.skills}: ${v.toFixed(0)} (mean score ${c.mean_score.toFixed(2)} over ${c.pass + c.partial + c.fail} judged runs)`;
      return `<g><path d="${barPath(x, y(v), barW, base)}" ${fill(c, slots)}><title>${esc(tip)}</title></path>
<text x="${cx}" y="${y(v) - 7}" text-anchor="middle" class="bar-value">${v.toFixed(0)}</text>
<text x="${cx}" y="${base + 17}" text-anchor="middle" class="tick-name">${esc(c.model)}</text>
<text x="${cx}" y="${base + 33}" text-anchor="middle" class="label">${esc(c.skills)}</text></g>`;
    })
    .join('\n');
  return `<div class="scroll"><svg viewBox="0 0 ${W} ${H}" width="${W}" class="ranking" role="img" aria-label="Configurations ranked by score">
${grid}
${bars}
</svg></div>`;
}

/** 1-2-5 ticks inside a positive range, for a log axis. */
export function logTicks(lo, hi) {
  const ticks = [];
  for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e += 1) {
    for (const m of [1, 2, 5]) {
      const t = m * 10 ** e;
      if (t >= lo && t <= hi) ticks.push(t);
    }
  }
  return ticks;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/**
 * The configurations no other beats on both counts, cheapest first: each scores higher than
 * every cheaper one.
 */
export function paretoFront(points) {
  const front = [];
  let best = -Infinity;
  for (const p of [...points].sort((a, b) => a.cost - b.cost || b.score - a.score)) {
    if (p.score > best) {
      front.push(p);
      best = p.score;
    }
  }
  return front;
}

const money = (v) => (v >= 1 ? `$${v.toFixed(v % 1 ? 1 : 0)}` : `$${Number(v.toPrecision(2))}`);

/**
 * The score axis: 0–100 zoomed to the data in steps of 10, with a step of headroom each side, so
 * configurations that differ by a few points do not sit on one line.
 */
export function scoreRange(scores) {
  const lo = Math.max(0, Math.floor(Math.min(...scores) / 10) * 10 - 10);
  const hi = Math.min(100, Math.ceil(Math.max(...scores) / 10) * 10 + 10);
  return [lo, hi];
}

/**
 * Spread label baselines at least `gap` apart, keeping each as close to its point as it can:
 * sort by y, push down past the one above, then pull the whole run back inside `[min, max]`.
 */
export function spreadLabels(ys, gap, min, max) {
  const order = ys.map((y, i) => [y, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(ys.length);
  let prev = -Infinity;
  for (const [y, i] of order) {
    out[i] = Math.max(y, prev + gap);
    prev = out[i];
  }
  const over = Math.max(...out) - max;
  if (over > 0) for (let i = 0; i < out.length; i++) out[i] = Math.max(min, out[i] - over);
  return out;
}

/**
 * Score (0–100) against mean cost per task (log scale), one point per configuration with both.
 * The most attractive quadrant is cheaper and better than the median configuration. Only the
 * Pareto points are labelled; hovering any point shows its label and numbers.
 */
export function valueChart(configs, slots) {
  const pts = configs
    .filter((c) => c.mean_score != null && c.mean_cost > 0)
    .map((c) => ({ c, cost: c.mean_cost, score: indexScore(c) }));
  if (!pts.length) return '<p class="muted">No configuration has both a score and a cost yet.</p>';
  const [W, H] = [1100, 620];
  const [left, right, top, bottom] = [60, 250, 16, 52];
  const [yLo, yHi] = scoreRange(pts.map((p) => p.score));
  const costs = pts.map((p) => p.cost);
  const lo = Math.log10(Math.min(...costs) / 1.8);
  const hi = Math.log10(Math.max(...costs) * 1.8);
  const x = (v) => left + ((Math.log10(v) - lo) / (hi - lo)) * (W - left - right);
  const y = (v) => top + (1 - (v - yLo) / (yHi - yLo)) * (H - top - bottom);
  const [mx, my] = [x(median(costs)), y(median(pts.map((p) => p.score)))];
  const xTicks = logTicks(10 ** lo, 10 ** hi)
    .map(
      (t) =>
        `<line x1="${x(t)}" x2="${x(t)}" y1="${top}" y2="${H - bottom}" class="grid"/><text x="${x(t)}" y="${H - bottom + 18}" text-anchor="middle" class="label">${money(t)}</text>`
    )
    .join('');
  const yTicks = Array.from({ length: (yHi - yLo) / 10 + 1 }, (_, i) => yLo + i * 10)
    .map(
      (v) =>
        `<line x1="${left}" x2="${W - right}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${left - 8}" y="${y(v) + 4}" text-anchor="end" class="label">${v}</text>`
    )
    .join('');
  const front = paretoFront(pts);
  const pareto =
    front.length > 1
      ? `<polyline points="${front.map((p) => `${x(p.cost).toFixed(1)},${y(p.score).toFixed(1)}`).join(' ')}" class="pareto"/>`
      : '';
  const onFront = new Set(front);
  // Frontier labels sit right of their points, spread so neighbours never overprint.
  const labelled = pts.filter((p) => onFront.has(p));
  const labelY = spreadLabels(
    labelled.map((p) => y(p.score) + 5),
    18,
    top + 12,
    H - bottom - 4
  );
  const labelAt = new Map(labelled.map((p, i) => [p, labelY[i]]));
  // Frontier labels go under the dots, so a label's halo never hides a neighbouring point; a
  // hover label rides with its own dot.
  const layers = { labels: [], dots: [] };
  for (const p of pts) {
    const { c, cost, score } = p;
    const [px, py] = [x(cost), y(score)];
    const name = `${c.model} · ${c.skills}`;
    const tip = `${name}: score ${score.toFixed(0)}, $${cost.toFixed(3)} per task`;
    const isFront = onFront.has(p);
    const ly = isFront ? labelAt.get(p) : py + 5;
    const leader =
      isFront && Math.abs(ly - 5 - py) > 3
        ? `<line x1="${(px + 8).toFixed(1)}" y1="${py.toFixed(1)}" x2="${(px + 14).toFixed(1)}" y2="${(ly - 5).toFixed(1)}" class="leader"/>`
        : '';
    const label = `<text x="${(px + 15).toFixed(1)}" y="${ly.toFixed(1)}" class="point-label${isFront ? '' : ' on-hover'}">${esc(name)}</text>`;
    if (isFront) layers.labels.push(`${leader}${label}`);
    layers.dots.push(
      `<g class="pt${isFront ? ' front' : ''}"><circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${isFront ? 8 : 7}" ${fill(c, slots)}><title>${esc(tip)}</title></circle>${isFront ? '' : label}</g>`
    );
  }
  const marks = [...layers.labels, ...layers.dots].join('\n');
  const quadKey = `<li><span class="swatch quad"></span>most attractive quadrant</li>${
    pareto
      ? '<li><span class="swatch pareto-key"></span>Pareto line (labelled; hover the rest)</li>'
      : ''
  }`;
  // A lone frontier point is cheapest and best at once: say so instead of drawing a line.
  const dominant =
    front.length === 1 && pts.length > 1
      ? `<p class="muted">No Pareto line: ${esc(front[0].c.model)} · ${esc(front[0].c.skills)} is both the cheapest and the best, so it beats every other configuration on both counts.</p>`
      : '';
  return `${chartLegend(slots, quadKey)}
<div class="scroll"><svg viewBox="0 0 ${W} ${H}" class="value" role="img" aria-label="Score against cost per task">
<rect x="${left}" y="${top}" width="${(mx - left).toFixed(1)}" height="${(my - top).toFixed(1)}" class="quad-good"/>
<rect x="${mx.toFixed(1)}" y="${my.toFixed(1)}" width="${(W - right - mx).toFixed(1)}" height="${(H - bottom - my).toFixed(1)}" class="quad-rest"/>
${yTicks}
${xTicks}
<text x="${left + 8}" y="${top + 16}" class="quad-label">most attractive quadrant</text>
${pareto}
${marks}
<text x="${(left + W - right) / 2}" y="${H - 8}" text-anchor="middle" class="axis-title">Cost per task (USD, log scale)</text>
<text transform="translate(14 ${(top + H - bottom) / 2}) rotate(-90)" text-anchor="middle" class="axis-title">Score (mean rubric score × 100)</text>
</svg></div>${dominant}`;
}

const score2 = (x) => (x == null ? '–' : x.toFixed(2));

/**
 * How often each configuration answered without a single tool call, and what that did to its
 * score. One row per configuration with counted transcripts, most tool-free first: a split bar
 * (grey: without tools; the model's color: with tools) and the two mean scores.
 */
export function toolUseChart(configs, slots) {
  const rows = configs
    .filter((c) => c.tool_known)
    .sort((a, b) => b.no_tool_rate - a.no_tool_rate || a.model.localeCompare(b.model));
  if (!rows.length) return '<p class="muted">No transcripts counted yet.</p>';
  const items = rows
    .map((c) => {
      const tooled = c.tool_known - c.no_tool_runs;
      const label = `${c.no_tool_runs} of ${c.tool_known} runs without tools, ${tooled} with`;
      return `<li class="tooluse-row">
  <span class="tooluse-name">${esc(c.model)} · ${esc(c.skills)}</span>
  <span class="bar tooluse-bar" role="img" aria-label="${esc(label)}" title="${esc(label)}"><span class="seg bare" style="flex:${c.no_tool_runs}"></span><span class="seg ${withSkills(c) ? 'with' : 'without'}" style="flex:${tooled}; --c: var(--series-${slots.get(c.model)})"></span></span>
  <span class="tooluse-text"><strong>${(c.no_tool_rate * 100).toFixed(0)}%</strong> without tools · mean score ${score2(c.no_tool_mean_score)} without vs ${score2(c.tool_mean_score)} with</span>
</li>`;
    })
    .join('\n');
  return `<ul class="tooluse">${items}</ul>`;
}
