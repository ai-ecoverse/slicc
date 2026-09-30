#!/usr/bin/env node
// Aggregates hf-reads.mjs output into Markdown tables.
//
//   node packages/bench/analysis/hf-reads-report.mjs <hf-reads.jsonl> <cache-dir> > part2.md
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fmt, median, pct, pushTo, quantile, readJsonl, table, topShares } from './lib.mjs';

const shortModel = (m) => String(m ?? 'unknown').replace(/-\d{8}$/, '');
const group = (r) => `${r.harness}\t${shortModel(r.model)}`;
/** First-window reads: ranged reads that start at line 1 (head -N, sed -n 1,Np, read limit=N). */
const firstWindow = (r) => r.requested != null && (r.from ?? 1) <= 1;
const whole = (r) => r.requested == null && /^(read \(default\)|cat)$/.test(r.method);
const BUCKETS = [
  ['≤ 100 lines', 0, 100],
  ['101–300', 101, 300],
  ['301–1000', 301, 1000],
  ['> 1000', 1001, 1e12],
];
/** "full share (n=…)" for the reads whose file length falls in [lo, hi]. */
const fullIn = (xs, lo, hi) => {
  const b = xs.filter((r) => r.fileLines >= lo && r.fileLines <= hi);
  return b.length ? `${pct(b.filter((r) => r.full).length, b.length)} (n=${b.length})` : '–';
};
const known = (xs) => xs.filter((r) => r.fileLines && r.delivered != null);

function datasetsTable(rows, cache) {
  const body = [...new Set(rows.map((r) => r.dataset))].map((d) => {
    const metaPath = join(cache, d.replace('/', '__'), '_meta.json');
    const m = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : {};
    const rs = rows.filter((r) => r.dataset === d);
    const models = [...new Set(rs.map((r) => shortModel(r.model)))].slice(0, 4).join(', ');
    return [
      d,
      (m.sha ?? '').slice(0, 10),
      m.license ?? '?',
      `${m.sampled}/${m.totalFiles}`,
      new Set(rs.map((r) => r.session)).size,
      rs.length,
      `${rs[0]?.harness} · ${models}`,
    ];
  });
  const head = [
    'dataset',
    'revision',
    'licence',
    'files sampled',
    'sessions with tool calls',
    'read events',
    'harness · models',
  ];
  return `### Datasets\n\n${table(head, body)}`;
}

function overviewTable(big) {
  const body = big.map(([k, v]) => {
    const fw = v.filter(firstWindow).map((r) => r.requested);
    const k1 = known(v).filter((r) => (r.from ?? 1) <= 1);
    return [
      ...k.split('\t'),
      v.length,
      pct(v.filter((r) => r.tool === 'read-tool').length, v.length),
      pct(v.filter(whole).length, v.length),
      pct(fw.length, v.length),
      `${fmt(median(fw))} (${fmt(quantile(fw, 0.25))}–${fmt(quantile(fw, 0.75))})`,
      `${pct(k1.filter((r) => r.full).length, k1.length)} (n=${k1.length})`,
      `${fmt(100 * median(k1.map((r) => r.frac)))}%`,
    ];
  });
  const head = [
    'harness',
    'model',
    'reads',
    'via read tool',
    'whole-file request',
    'first-window request (head/sed 1,N/limit)',
    'median N of first window (IQR)',
    'full (length known)',
    'median % delivered (length known)',
  ];
  return `### How agents read files, by harness and model (all file types)\n\n${table(head, body)}`;
}

function windowTable(big) {
  const body = big.map(([k, v]) => [
    ...k.split('\t'),
    topShares(
      v.filter(firstWindow).map((r) => r.requested),
      6
    ) || '–',
  ]);
  return `### Most common first-window sizes\n\n${table(['harness', 'model', 'top N values (share of first-window reads)'], body)}`;
}

function lengthTable(big) {
  const body = big.map(([k, v]) => {
    const f = known(v).filter((r) => r.ordinal === 1);
    return [...k.split('\t'), ...BUCKETS.map(([, lo, hi]) => fullIn(f, lo, hi))];
  });
  const head = ['harness', 'model', ...BUCKETS.map((b) => b[0])];
  return `### Full reads by file length (first read of a file in a session, length known)\n\n${table(head, body)}`;
}

/** Claude Code's Read tool reports totalLines on every call, so this slice has no length-known bias. */
function claudeCodeReadTable(rows) {
  const cc = rows.filter(
    (r) => r.harness === 'claude-code' && r.tool === 'read-tool' && r.fileLines && r.ordinal === 1
  );
  const body = [...new Set(cc.map((r) => shortModel(r.model)))].map((m) => {
    const xs = cc.filter((r) => shortModel(r.model) === m);
    return [
      m,
      xs.length,
      pct(xs.filter((r) => r.method !== 'read (default)').length, xs.length),
      ...BUCKETS.map(([, lo, hi]) => fullIn(xs, lo, hi)),
    ];
  });
  const head = [
    'model',
    'first reads',
    'passed limit/offset',
    ...BUCKETS.map((b) => `full, ${b[0]}`),
  ];
  return `### Claude Code \`Read\` tool only (file length always known: no selection bias)\n\n${table(head, body)}`;
}

const CLASSES = [
  ['SKILL.md / CLAUDE.md / AGENTS.md', (r) => r.cls === 'skill' || r.cls === 'agent-instructions'],
  ['README / *.md / docs', (r) => r.cls === 'docs'],
  ['source', (r) => r.cls === 'source'],
];

function classTable(big) {
  const body = [];
  for (const [k, v] of big)
    for (const [name, pred] of CLASSES) {
      const xs = v.filter((r) => r.ordinal === 1 && pred(r));
      if (xs.length < 5) continue;
      const kn = known(xs);
      body.push([
        ...k.split('\t'),
        name,
        xs.length,
        pct(xs.filter(whole).length, xs.length),
        pct(xs.filter(firstWindow).length, xs.length),
        fmt(median(xs.filter(firstWindow).map((r) => r.requested))),
        kn.length ? `${pct(kn.filter((r) => r.full).length, kn.length)} (n=${kn.length})` : '–',
        fmt(median(kn.map((r) => r.fileLines))),
      ]);
    }
  const head = [
    'harness',
    'model',
    'file class',
    'first reads',
    'whole-file request',
    'first-window request',
    'median N',
    'full (length known)',
    'median file lines',
  ];
  return `### Instruction and documentation files vs source (first read in a session)\n\n${table(head, body)}`;
}

export function report(rows, cache) {
  const groups = new Map();
  for (const r of rows) pushTo(groups, group(r), r);
  const big = [...groups]
    .filter(([, v]) => v.length >= 40)
    .sort((a, b) => b[1].length - a[1].length);
  return [
    datasetsTable(rows, cache),
    overviewTable(big),
    windowTable(big),
    lengthTable(big),
    claudeCodeReadTable(rows),
    classTable(big),
  ].join('\n\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(report(readJsonl(readFileSync(process.argv[2], 'utf8')), process.argv[3] ?? '.'));
}
