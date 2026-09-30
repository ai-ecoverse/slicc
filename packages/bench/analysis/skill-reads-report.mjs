#!/usr/bin/env node
// Aggregates skill-reads.mjs output into Markdown tables (aggregates only).
//
//   node packages/bench/analysis/skill-reads-report.mjs <reads.jsonl>          > part1.md
//   node packages/bench/analysis/skill-reads-report.mjs <reads.jsonl> --svg    > reach.svg
import { readFileSync } from 'node:fs';
import { fmt, median, pct, pushTo, quantile, readJsonl, table, topShares } from './lib.mjs';

/** Run directory → condition label. Runs not listed are grouped as `early`. */
export const CONDITIONS = {
  'run-36494765111': 'full skill (frontier)',
  'run-36542822404': 'full skill (frontier)',
  'run-36542846444': 'full skill (frontier)',
  'run-36547416060': 'skills=none',
  'run-36593001312': 'slim VFS (#3634)',
  'run-36627096386': '1k skill (#3650)',
  'run-36665406202': 'strategy (#3665)',
  'run-36668461760': 'web discipline (#3666)',
  'run-36668481859': 'page-state (#3669)',
  'run-36663826241-partial': 'full skill (Sol, partial)',
};

const PW = '/workspace/skills/playwright-cli/SKILL.md';
const FULL = 0.95;
const cond = (r) => CONDITIONS[r.run] ?? 'early (6.197–6.205)';
/** Reading-behaviour family: Claude 5.5 splits by effort; older Claude, GPT and Kimi read whole files. */
export const family = (r) => {
  if (/^claude-(sonnet|opus)-5-5/.test(r.model))
    return `Claude 5.5 ${r.thinking === 'default' ? 'default' : `@${r.thinking}`}`;
  return /^claude/.test(r.model) ? 'Claude (Sonnet 5, Fable 5.1)' : 'GPT-6.x + Kimi K3';
};
const FAMILIES = [
  'Claude 5.5 @low',
  'Claude 5.5 default',
  'Claude 5.5 @max',
  'Claude (Sonnet 5, Fable 5.1)',
  'GPT-6.x + Kimi K3',
];
const label = (r) => `${r.model}${r.thinking === 'default' ? '' : `@${r.thinking}`}`;
const key = (r) => `${cond(r)}\t${label(r)}`;
const runKey = (r) => `${r.run}\t${r.task}\t${r.repeat}`;
const methodKey = (r) => {
  if (r.method === 'read_file') return 'read_file (no limit)';
  if (r.method === 'read_file+range')
    return `read_file limit ${r.n ?? '–'}${r.offset > 1 ? ` offset ${r.offset}` : ''}`;
  if (r.method === 'sed-range') return `sed -n ${r.n ?? '?'}`;
  if (/head-c/.test(r.method)) return `head -c ${r.n}`;
  if (/head/.test(r.method)) return `head -${r.n}`;
  return r.method === 'cat' ? 'cat (whole)' : r.method;
};
/** Expands "1-60,80-120" to a Set of 1-based lines. */
const lineSet = (ranges) => {
  const s = new Set();
  for (const part of String(ranges ?? '')
    .split(',')
    .filter(Boolean)) {
    const [a, b = a] = part.split('-').map(Number);
    for (let i = a; i <= b; i++) s.add(i);
  }
  return s;
};
const seenLines = (reads) => {
  const s = new Set();
  for (const r of reads) for (const l of lineSet(r.ranges)) s.add(l);
  return s;
};
const maxCum = (reads) => Math.max(...reads.map((r) => r.cumFrac));

/** Groups read rows: per (run, file) in call order, then per condition key for one file. */
function index(rows) {
  const runs = rows.filter((r) => r.kind === 'run');
  const perRun = new Map();
  for (const r of rows.filter((x) => x.kind === 'read' && (x.lines ?? 0) > 0))
    pushTo(perRun, `${runKey(r)}\t${r.model}\t${r.thinking}\t${r.path}`, r);
  for (const v of perRun.values()) v.sort((a, b) => a.callIndex - b.callIndex);
  const pw = new Map();
  for (const v of perRun.values()) if (v[0].path === PW) pushTo(pw, key(v[0]), v);
  const den = new Map();
  for (const r of runs) den.set(key(r), (den.get(key(r)) ?? 0) + 1);
  const order = [...den.keys()].filter((k) => den.get(k) >= 10).sort();
  return { runs, perRun, pw, den, order };
}

function conditionTable({ pw, den, order }) {
  const row = (k) => {
    const v = pw.get(k) ?? [];
    const first = v.map((x) => x[0]);
    const ls = first.map((x) => x.maxLine);
    const size = first.length
      ? `${first[0].fileLines} / ${fmt(first[0].fileBytes / 1024, 1)}`
      : '–';
    return [
      ...k.split('\t'),
      size,
      den.get(k),
      `${v.length} (${pct(v.length, den.get(k))})`,
      `${fmt(median(ls))} (${fmt(quantile(ls, 0.25))}–${fmt(quantile(ls, 0.75))})`,
      `${fmt(100 * median(first.map((x) => x.frac)))}%`,
      pct(first.filter((x) => x.frac >= FULL).length, v.length),
      pct(v.filter((x) => maxCum(x) >= FULL).length, v.length),
      pct(v.filter((x) => x.filter((y) => y.newLines > 0).length > 1).length, v.length),
      v.flat().filter((x) => x.harnessTruncated).length,
    ];
  };
  const head = [
    'condition',
    'model',
    'file (lines / KB)',
    'runs',
    'opened',
    'first read: median lines (IQR)',
    'first read: % of file',
    'full at first read',
    'full over the run',
    'came back for more',
    'harness-truncated reads',
  ];
  return `### \`playwright-cli/SKILL.md\`: per condition\n\n${table(head, order.map(row))}`;
}

function methodTable({ pw, order }) {
  const byModel = new Map();
  for (const k of order)
    for (const v of pw.get(k) ?? []) pushTo(byModel, k.split('\t')[1], methodKey(v[0]));
  const rows = [...byModel].map(([m, xs]) => [m, xs.length, topShares(xs, 6, (x) => `\`${x}\``)]);
  return `### How the first read of \`playwright-cli/SKILL.md\` was made\n\n${table(['model', 'first reads', 'top methods'], rows)}`;
}

const BUCKETS = [
  ['≤ 40 lines', 0, 40],
  ['41–100', 41, 100],
  ['101–200', 101, 200],
  ['201–300', 201, 300],
  ['> 300', 301, 1e9],
];

function depthTable({ perRun }) {
  const firsts = [...perRun.values()].map((v) => v[0]);
  const rows = [];
  for (const [name, lo, hi] of BUCKETS)
    for (const f of FAMILIES) {
      const xs = firsts.filter((r) => r.fileLines >= lo && r.fileLines <= hi && family(r) === f);
      if (xs.length)
        rows.push([
          name,
          f,
          xs.length,
          pct(xs.filter((r) => r.frac >= FULL).length, xs.length),
          `${fmt(100 * median(xs.map((r) => r.frac)))}%`,
          fmt(median(xs.map((r) => r.lines))),
        ]);
    }
  const head = [
    'file length',
    'family',
    'first reads',
    'full (≥95%)',
    'median % delivered',
    'median lines delivered',
  ];
  return `### Depth vs file length (first read of each file per run, all files and models)\n\n${table(head, rows)}`;
}

function laterTable({ pw }) {
  const all = [...pw.values()].flat();
  const start = (r) => Math.min(...lineSet(r.ranges));
  const rows = [];
  for (const f of FAMILIES) {
    const v = all.filter((x) => family(x[0]) === f);
    for (const [name, xs] of [
      ['first', v.map((x) => x[0])],
      ['later', v.flatMap((x) => x.slice(1))],
    ])
      if (xs.length)
        rows.push([
          f,
          name,
          xs.length,
          fmt(median(xs.map(start))),
          fmt(median(xs.map((r) => r.lines))),
          fmt(median(xs.map((r) => r.maxLine))),
          pct(xs.filter((r) => r.frac >= FULL).length, xs.length),
          pct(xs.filter((r) => r.newLines > 0).length, xs.length),
        ]);
  }
  const head = [
    'family',
    'reads',
    'n',
    'median start line',
    'median lines delivered',
    'median last line',
    'full',
    'delivered new lines',
  ];
  return `### First vs later reads of \`playwright-cli/SKILL.md\`\n\n${table(head, rows)}`;
}

const MARKS = [20, 40, 60, 80, 100, 150, 200, 300, 400];
const sawLine = (s, m) => s.has(m) || s.has(m - 1) || s.has(m + 1);

function reachTable({ pw, order }) {
  const rows = order
    .filter((k) => (pw.get(k) ?? []).length >= 10)
    .map((k) => {
      const v = pw.get(k);
      const seen = v.map(seenLines);
      const fl = v[0][0].fileLines;
      return [
        ...k.split('\t'),
        v.length,
        ...MARKS.map((m) =>
          m > fl ? '–' : pct(seen.filter((s) => sawLine(s, m)).length, v.length)
        ),
      ];
    });
  const head = ['condition', 'model', 'opened', ...MARKS.map((m) => `L${m}`)];
  return `### Reach: share of runs that opened the file and saw line L (union of all reads in the run)\n\n${table(head, rows)}`;
}

const coverageBin = (f) => {
  if (f == null) return 'not opened';
  if (f < 0.25) return '< 25%';
  return f < FULL ? '25–95%' : '≥ 95%';
};
const meanCell = (xs) =>
  xs.length ? `${fmt(xs.reduce((a, b) => a + b, 0) / xs.length, 2)} (n=${xs.length})` : '–';

function scoreTable({ pw, runs, order }) {
  const rows = [];
  for (const k of order) {
    const cov = new Map((pw.get(k) ?? []).map((v) => [runKey(v[0]), maxCum(v)]));
    const bins = { 'not opened': [], '< 25%': [], '25–95%': [], '≥ 95%': [] };
    for (const r of runs.filter((x) => key(x) === k && x.score != null))
      bins[coverageBin(cov.get(runKey(r)))].push(r.score);
    if (Object.values(bins).flat().length >= 20)
      rows.push([...k.split('\t'), ...Object.values(bins).map(meanCell)]);
  }
  const head = ['condition', 'model', 'not opened', '< 25%', '25–95%', '≥ 95%'];
  return `### Score by how much of \`playwright-cli/SKILL.md\` the run saw (confounded: see caveats)\n\n${table(head, rows)}`;
}

function otherFilesTable({ perRun }) {
  const byPath = new Map();
  for (const v of perRun.values()) if (v[0].path !== PW) pushTo(byPath, v[0].path, v[0]);
  const rows = [...byPath]
    .filter(([, v]) => v.length >= 8)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([p, v]) => [
      `\`${p.replace('/workspace/', '')}\``,
      v[0].fileLines ?? '–',
      v.length,
      pct(v.filter((r) => r.frac >= FULL).length, v.length),
      `${fmt(100 * median(v.map((r) => r.frac)))}%`,
      topShares(v.map(methodKey), 3, (x) => `\`${x}\``),
    ]);
  const head = [
    'file',
    'lines',
    'runs that read it',
    'full at first read',
    'median % delivered',
    'top methods',
  ];
  return `### Other skill files and CLAUDE.md (all conditions)\n\n${table(head, rows)}`;
}

export function report(rows) {
  const ix = index(rows);
  return [
    conditionTable,
    methodTable,
    depthTable,
    laterTable,
    reachTable,
    scoreTable,
    otherFilesTable,
  ]
    .map((f) => f(ix))
    .join('\n\n');
}

/** Reach curves for `playwright-cli/SKILL.md`: share of runs that opened it and saw line L. */
export function reachSvg(rows) {
  const series = [
    ['full skill (frontier)', 'claude-sonnet-5-5', 'default', 'Sonnet 5.5'],
    ['full skill (frontier)', 'claude-opus-5-5', 'default', 'Opus 5.5'],
    ['full skill (frontier)', 'claude-opus-5-5', 'max', 'Opus 5.5 @max'],
    ['full skill (frontier)', 'gpt-6-luna', 'default', 'GPT-6 Luna'],
    ['web discipline (#3666)', 'claude-sonnet-5-5', 'default', 'Sonnet 5.5, #3666'],
  ];
  const colors = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4'];
  const reads = rows.filter((r) => r.kind === 'read' && r.path === PW && (r.lines ?? 0) > 0);
  const W = 760,
    H = 400,
    L = 56,
    R = 190,
    T = 44,
    B = 48;
  const x = (v) => L + (v / 420) * (W - L - R);
  const y = (v) => T + (1 - v) * (H - T - B);
  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="system-ui, sans-serif" font-size="12">`,
    `<rect width="${W}" height="${H}" fill="#fcfcfb"/>`,
  ];
  out.push(
    `<text x="${L}" y="22" font-size="14" font-weight="600" fill="#1a1a19">Which lines of playwright-cli/SKILL.md reached the model</text>`
  );
  out.push(
    `<text x="${L}" y="37" fill="#5f5e58">Share of runs that opened the file whose reads included line L (union over the run)</text>`
  );
  for (const v of [0, 0.25, 0.5, 0.75, 1])
    out.push(
      `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#e6e5e0"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end" fill="#5f5e58">${v * 100}%</text>`
    );
  for (const v of [0, 60, 80, 100, 200, 300, 400])
    out.push(`<text x="${x(v)}" y="${H - B + 18}" text-anchor="middle" fill="#5f5e58">${v}</text>`);
  out.push(
    `<line x1="${x(80)}" x2="${x(80)}" y1="${T}" y2="${H - B}" stroke="#b5b4ac" stroke-dasharray="3 3"/><text x="${x(80) + 4}" y="${y(0.5)}" fill="#5f5e58">line 80</text>`
  );
  out.push(
    `<text x="${(L + W - R) / 2}" y="${H - 10}" text-anchor="middle" fill="#5f5e58">line number in SKILL.md</text>`
  );
  const ends = [];
  series.forEach(([c, m, t, name], i) => {
    const runs = new Map();
    for (const r of reads.filter((r) => cond(r) === c && r.model === m && r.thinking === t)) {
      const k = `${r.run}\t${r.task}\t${r.repeat}`;
      if (!runs.has(k)) runs.set(k, new Set());
      for (const l of lineSet(r.ranges)) runs.get(k).add(l);
    }
    const sets = [...runs.values()];
    if (!sets.length) return;
    const pts = [];
    for (let l = 1; l <= 408; l += 3)
      pts.push([
        l,
        sets.filter((s) => s.has(l) || s.has(l + 1) || s.has(l - 1)).length / sets.length,
      ]);
    out.push(
      `<polyline fill="none" stroke="${colors[i]}" stroke-width="2" stroke-linejoin="round" points="${pts.map(([a, b]) => `${x(a).toFixed(1)},${y(b).toFixed(1)}`).join(' ')}"/>`
    );
    ends.push({ yv: y(pts.at(-1)[1]), name: `${name} (n=${sets.length})`, color: colors[i] });
  });
  // Direct labels at the right edge, nudged apart so they never collide.
  ends.sort((a, b) => a.yv - b.yv);
  for (let i = 1; i < ends.length; i++) ends[i].yv = Math.max(ends[i].yv, ends[i - 1].yv + 15);
  for (const e of ends)
    out.push(
      `<rect x="${W - R + 8}" y="${e.yv - 5}" width="10" height="3" rx="1.5" fill="${e.color}"/><text x="${W - R + 22}" y="${e.yv}" fill="#1a1a19">${e.name}</text>`
    );
  out.push('</svg>');
  return out.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = readJsonl(readFileSync(process.argv[2], 'utf8'));
  console.log(process.argv[3] === '--svg' ? reachSvg(rows) : report(rows));
}
