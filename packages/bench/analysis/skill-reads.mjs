#!/usr/bin/env node
// Extracts every read of a skill file or CLAUDE.md from encrypted bench traces and
// measures what reached the model: the lines of the file that appear in the tool
// result (so harness truncation counts), not what the command asked for.
//
//   node packages/bench/analysis/skill-reads.mjs <data-dir> <out.jsonl> [run-dir ...]
//
// <data-dir> holds run-<id>/traces/**.enc (see bench-analysis/fetch.sh). Writes one
// JSON row per (tool call, file) with aggregates only: no task text, no tool output.
// File contents come from git: every blob of the path across the refs below, and
// per run the blob that best explains the observed reads wins.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decryptSetFile } from '../scripts/upstream.mjs';
import { pushTo, splitShell } from './lib.mjs';

const REFS = [
  'v6.205.0',
  'v6.215.1',
  'v6.218.0',
  'v6.220.0',
  'v6.225.0',
  'v6.226.0',
  'cacc7e88b', // pinned baseline of the skill experiments
  'origin/exp/slim-playwright-skill-1k',
  'origin/exp/playwright-skill-strategy',
  'origin/exp/playwright-skill-web-discipline',
  'origin/exp/playwright-skill-page-state',
  'origin/bb/experiment-slimmer-vfs-skills-and-default-claude-thr_racwhm6wa9',
  '38cd65681', // #3666 pin
  'c24b09d09', // #3669 pin
];

/** Skill source per run, for ties (reads that don't tell versions apart). */
export const RUN_REF = {
  'run-36593001312': 'origin/bb/experiment-slimmer-vfs-skills-and-default-claude-thr_racwhm6wa9', // #3634 slim VFS
  'run-36627096386': 'origin/exp/slim-playwright-skill-1k', // #3650
  'run-36665406202': 'origin/exp/playwright-skill-strategy', // #3665
  'run-36668461760': '38cd65681', // #3666 web-task discipline
  'run-36668481859': 'c24b09d09', // #3669 page-state helper
};
const DEFAULT_REF = 'cacc7e88b';

const git = (...args) =>
  execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 64 << 20,
    stdio: ['ignore', 'pipe', 'ignore'],
  });

/** Main commits that touched the VFS since the first run: hosted leaders load production. */
const historyRefs = (since = '2026-09-10') =>
  git(
    'log',
    '--format=%h',
    `--since=${since}`,
    'origin/main',
    '--',
    'packages/vfs-root/workspace/skills',
    'packages/vfs-root/shared'
  )
    .split('\n')
    .filter(Boolean);

/** VFS path → Map(blobSha → { text, refs }) across REFS and recent main history. */
export function loadCorpus(refs = [...REFS, ...historyRefs()]) {
  const corpus = new Map();
  for (const ref of refs) {
    let tree;
    try {
      tree = git(
        'ls-tree',
        '-r',
        ref,
        '--',
        'packages/vfs-root/workspace/skills',
        'packages/vfs-root/shared/CLAUDE.md'
      );
    } catch {
      continue;
    }
    for (const line of tree.split('\n')) {
      const m = /^\d+ blob ([0-9a-f]+)\t(.+\.md)$/.exec(line);
      if (!m) continue;
      const vfs = m[2].replace('packages/vfs-root', '');
      if (!corpus.has(vfs)) corpus.set(vfs, new Map());
      const blobs = corpus.get(vfs);
      if (!blobs.has(m[1]))
        blobs.set(m[1], { text: git('cat-file', 'blob', m[1]), refs: new Set() });
      blobs.get(m[1]).refs.add(ref);
    }
  }
  return corpus;
}

const PATH_RE = /(?:[\w./~-]*\/)?(?:skills\/[\w.*-]+\/[\w.*/-]+\.md|CLAUDE\.md|SKILL\.md)/g;

/** Splits a shell command into pipelines (by ; && || newline), keeping `cd` context. */
export function pipelines(command) {
  const out = [];
  let cwd = '/';
  for (const raw of splitShell(String(command), ['&&', '||', ';', '\n'])) {
    const seg = raw.trim();
    if (!seg) continue;
    const cd = /^cd\s+([^\s|]+)/.exec(seg);
    if (cd) {
      cwd = resolvePath(cwd, cd[1].replace(/['"]/g, ''));
      continue;
    }
    out.push({ seg, cwd });
  }
  return out;
}

export function resolvePath(cwd, p) {
  p = p.replace(/^~\//, '/workspace/').replace(/^\$HOME\//, '/workspace/');
  const abs = p.startsWith('/') ? p : `${cwd.replace(/\/$/, '')}/${p}`;
  const parts = [];
  for (const s of abs.split('/')) {
    if (!s || s === '.') continue;
    if (s === '..') parts.pop();
    else parts.push(s);
  }
  return `/${parts.join('/')}`;
}

const META = new Set([
  'ls',
  'find',
  'stat',
  'test',
  '[',
  'echo',
  'mkdir',
  'cp',
  'mv',
  'rm',
  'touch',
]);
const PAGERS = new Set(['cat', 'less', 'more', 'bat']);

/** `head` line count: `head -N`, `head -n N`, `head --lines=N`; 10 when bare. */
export function headN(s) {
  const m = /head\s+(?:-n\s*)?-?(\d+)/.exec(s) ?? /head\s+--lines[= ](\d+)/.exec(s);
  if (m) return Number(m[1]);
  return /^head\b/.test(s) && !/-c/.test(s) ? 10 : undefined;
}

/** A `cat file | <filter>` pipeline, classified by the filter. */
function pagerMethod(cmd, filterStage) {
  const f = (filterStage ?? '').split(/\s+/)[0];
  if (f === 'head') {
    const c = /-c\s*(\d+)/.exec(filterStage);
    return c
      ? { method: 'cat|head-c', n: Number(c[1]) }
      : { method: 'cat|head', n: headN(filterStage) };
  }
  if (['sed', 'grep', 'tail'].includes(f)) return { method: `cat|${f}` };
  if (f === 'wc') return { method: 'wc' };
  return { method: cmd === 'cat' ? 'cat' : cmd };
}

/** The command that names the file, classified on its own. */
function sourceMethod(cmd, src) {
  if (cmd === 'head') {
    const c = /-c\s*(\d+)/.exec(src);
    return c ? { method: 'head-c', n: Number(c[1]) } : { method: 'head', n: headN(src) };
  }
  if (cmd === 'sed') {
    const r = /(\d+)\s*,\s*(\d+)\s*p/.exec(src);
    return { method: /-n/.test(src) ? 'sed-range' : 'sed', n: r ? `${r[1]}-${r[2]}` : undefined };
  }
  if (['grep', 'rg', 'egrep'].includes(cmd)) return { method: 'grep' };
  if (['awk', 'tail', 'wc'].includes(cmd)) return { method: cmd };
  if (META.has(cmd)) return { method: 'meta' };
  if (/^(python3?|node|jq)$/.test(cmd)) return { method: 'script' };
  return { method: cmd };
}

/** Classifies how one pipeline reads a file: cat, head-N, sed-range, grep, tail, … */
export function readMethod(seg, pathToken) {
  const stages = splitShell(seg, ['|']).map((s) => s.trim());
  const first = stages.findIndex((s) => s.includes(pathToken));
  const src = stages[first] ?? '';
  const cmd = src.split(/\s+/)[0].replace(/^.*\//, '');
  return PAGERS.has(cmd) ? pagerMethod(cmd, stages[first + 1]) : sourceMethod(cmd, src);
}

const norm = (s) => s.replace(/\s+$/, '');
const strip = (r) =>
  r
    .replace(/^\S*\.md[:-]\d+[:-]/, '') // grep -n with filename
    .replace(/^\S*\.md:/, '') // grep with filename
    .replace(/^\s*\d+[:\t-]\s?/, '') // grep -n / cat -n
    .replace(/\s+$/, '');

/** Index of the next non-blank file line after `last`. */
function nextLine(L, last) {
  let j = last + 1;
  while (j < L.length && !L[j].trim()) j++;
  return j;
}

/** File line that result line `r` matches, or -1 (see `delivered`). */
function matchLine(L, count, r, last) {
  const j = nextLine(L, last);
  const continues = j < L.length && L[j].trim() === r;
  if (continues && last >= 0) return j;
  if (r.length >= 12 && count.get(r) === 1) return L.findIndex((l) => l.trim() === r);
  if (continues && last < 0 && (r.length >= 3 || j === 0)) return j;
  return -1;
}

/**
 * Aligns tool-result lines to file lines. A match counts if it continues the
 * previous match (after blank lines) or the line is distinctive (≥12 chars,
 * unique in the file) — so a stray "```" elsewhere in the output can't claim depth.
 */
export function delivered(fileText, resultText) {
  const L = fileText.split('\n').map(norm);
  const count = new Map();
  for (const l of L) count.set(l.trim(), (count.get(l.trim()) ?? 0) + 1);
  const covered = new Set();
  let last = -1;
  let jumps = 0;
  for (const raw of String(resultText).split('\n')) {
    const r = strip(raw).trim();
    const hit = r ? matchLine(L, count, r, last) : -1;
    if (hit < 0) continue;
    const gap = last >= 0 && hit > last ? L.slice(last + 1, hit) : [];
    if (gap.every((l) => !l.trim()))
      for (let k = last + 1; k < hit && last >= 0; k++) covered.add(k);
    else jumps++;
    covered.add(hit);
    last = hit;
  }
  return summarise(L, fileText, covered, jumps);
}

function summarise(L, fileText, covered, jumps) {
  let bytes = 0;
  for (const k of covered) bytes += Buffer.byteLength(L[k]) + 1;
  const nonEmpty = L.filter((l) => l.trim()).length;
  const coveredNonEmpty = [...covered].filter((k) => L[k].trim()).length;
  return {
    covered,
    lines: covered.size,
    bytes,
    maxLine: covered.size ? Math.max(...covered) + 1 : 0,
    fileLines: L.length,
    fileBytes: Buffer.byteLength(fileText),
    frac: nonEmpty ? coveredNonEmpty / nonEmpty : 0,
    fit: coveredNonEmpty - 3 * jumps, // for picking the blob that explains a read best
  };
}

/** 0-based covered line set → "1-60,80-120" (1-based, inclusive). */
export function ranges(covered) {
  const xs = [...covered].sort((a, b) => a - b);
  const out = [];
  for (const x of xs) {
    const last = out.at(-1);
    if (last && x === last[1] + 1) last[1] = x;
    else out.push([x, x]);
  }
  return out.map(([a, b]) => (a === b ? `${a + 1}` : `${a + 1}-${b + 1}`)).join(',');
}

const walk = (d) =>
  readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

const textOf = (m) =>
  (m.content ?? [])
    .filter((x) => x.type === 'text')
    .map((x) => x.text)
    .join('\n');

/** Yields every tool call of a trace with its result text and running index. */
function* toolCalls(trace) {
  let callIndex = 0;
  for (const c of trace.result?.transcript?.conversations ?? []) {
    const results = new Map();
    for (const m of c.messages ?? [])
      if (m.role === 'tool-result') results.set(m.toolCallId, textOf(m));
    for (const m of c.messages ?? [])
      for (const part of m.content ?? []) {
        if (part.type !== 'tool-call') continue;
        callIndex++;
        yield {
          part,
          base: {
            conv: c.kind ?? c.name ?? 'cone',
            callIndex,
            tool: part.name,
            result: results.get(part.id) ?? '',
          },
        };
      }
  }
}

function readToolEvents(part, base) {
  const path = resolvePath('/workspace', String(part.input?.path ?? part.input?.file_path ?? ''));
  if (!isInstruction(path)) return [];
  const { limit, offset } = part.input ?? {};
  return [
    { ...base, path, method: limit || offset ? 'read_file+range' : 'read_file', n: limit, offset },
  ];
}

function bashEvents(part, base, knownPaths) {
  const events = [];
  for (const { seg, cwd } of pipelines(part.input?.command ?? '')) {
    const seen = new Set();
    for (const tok of seg.match(PATH_RE) ?? []) {
      const abs = resolvePath(cwd, tok.replace(/['"]/g, ''));
      const glob = abs.includes('*');
      for (const path of glob ? expandGlob(abs, knownPaths) : [abs]) {
        if (!isInstruction(path) || seen.has(path)) continue;
        seen.add(path);
        const { method, n } = readMethod(seg, tok);
        events.push({
          ...base,
          path,
          method: glob ? `glob:${method}` : method,
          n,
          seg: shape(seg),
        });
      }
    }
  }
  return events;
}

/** Every (tool call, file) read event in one trace. */
export function readEvents(trace, knownPaths) {
  const events = [];
  for (const { part, base } of toolCalls(trace)) {
    if (part.name === 'read_file' || part.name === 'read')
      events.push(...readToolEvents(part, base));
    else if (part.name === 'bash') events.push(...bashEvents(part, base, knownPaths));
  }
  return events;
}

const isInstruction = (p) => /\/skills\/.+\.md$/.test(p) || /CLAUDE\.md$/.test(p);
const expandGlob = (pat, known) => {
  const re = new RegExp(`^${pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`);
  return known.filter((p) => re.test(p));
};
/** Command shape for aggregation: paths and numbers generalised, nothing task-specific. */
export const shape = (seg) =>
  seg
    .replace(/\/?[\w./-]*skills\/([\w-]+)\/([\w.-]+)/g, 'skills/$1/$2')
    .replace(/(["']).*?\1/g, (m) =>
      /^['"]\d+,\d*p['"]$/.test(m) || /^['"]\d+p['"]$/.test(m) ? m : "'…'"
    )
    .slice(0, 80);

function pickBlob(blobs, results, ref) {
  let best;
  let bestScore = -1;
  for (const [sha, { text, refs }] of blobs) {
    let s = 0;
    for (const r of results) s += delivered(text, r).fit;
    s += refs.has(ref) ? 0.5 : 0; // tie-break toward the run's pinned source
    if (s > bestScore) [best, bestScore] = [{ sha, text }, s];
  }
  return best;
}

function loadTraces(dataDir, run, knownPaths) {
  const traces = [];
  for (const p of walk(join(dataDir, run)).filter(
    (f) => f.includes('/traces/') && f.endsWith('.enc')
  )) {
    let t;
    try {
      t = decryptSetFile(readFileSync(p, 'utf8'), 'BU_Bench_V2');
    } catch {
      continue;
    }
    if (t.result?.transcript?.conversations) traces.push({ t, events: readEvents(t, knownPaths) });
  }
  return traces;
}

/** One blob per (skills condition, path): the one that best explains every read in the run. */
function chooseBlobs(traces, corpus, ref) {
  const byPath = new Map();
  for (const { t, events } of traces)
    for (const e of events) pushTo(byPath, `${t.record.config.skills}\0${e.path}`, e.result);
  const chosen = new Map();
  for (const [k, results] of byPath) {
    const blobs = corpus.get(k.split('\0')[1]);
    chosen.set(k, blobs ? pickBlob(blobs, results, ref) : undefined);
  }
  return chosen;
}

function runRow(run, t) {
  const cfg = t.record.config;
  return {
    run,
    task: t.record.task_id,
    repeat: t.record.repeat,
    model: cfg.model.replace(/@.*$/, ''),
    thinking: cfg.thinking ?? 'default',
    skills: cfg.skills,
    harness: cfg.harness,
    score: t.record.score ?? null,
    outcome: t.record.outcome ?? null,
  };
}

function deliveredFields(d, prev) {
  if (!d)
    return {
      lines: null,
      bytes: null,
      maxLine: null,
      ranges: null,
      fileLines: null,
      fileBytes: null,
      frac: null,
      newLines: 0,
    };
  return {
    lines: d.lines,
    bytes: d.bytes,
    maxLine: d.maxLine,
    ranges: ranges(d.covered),
    fileLines: d.fileLines,
    fileBytes: d.fileBytes,
    frac: Number(d.frac.toFixed(4)),
    newLines: [...d.covered].filter((x) => !prev.has(x)).length,
  };
}

/** Rows for one trace: a `run` row, then one `read` row per event. */
function traceRows(run, t, events, chosen) {
  const base = runRow(run, t);
  const rows = [{ kind: 'run', ...base, toolCalls: t.record.metrics?.tool_calls ?? null }];
  const seenLines = new Map();
  const ordinal = new Map();
  events.forEach((e, i) => {
    const blob = chosen.get(`${base.skills}\0${e.path}`);
    const d = blob ? delivered(blob.text, e.result) : undefined;
    const prev = seenLines.get(e.path) ?? new Set();
    const seen = d ? new Set([...prev, ...d.covered]) : prev;
    seenLines.set(e.path, seen);
    ordinal.set(e.path, (ordinal.get(e.path) ?? 0) + 1);
    rows.push({
      kind: 'read',
      ...base,
      conv: e.conv,
      callIndex: e.callIndex,
      ordinal: ordinal.get(e.path),
      path: e.path,
      blob: blob?.sha?.slice(0, 10) ?? null,
      tool: e.tool,
      method: e.method,
      n: e.n ?? null,
      offset: e.offset ?? null,
      shape: e.seg ?? null,
      resultBytes: Buffer.byteLength(e.result),
      harnessTruncated: /\[Output truncated|\[Showing lines \d+-\d+ of/.test(e.result),
      ...deliveredFields(d, prev),
      cumFrac: d ? Number((seen.size / d.fileLines).toFixed(4)) : null,
      cameBack: events.slice(i + 1).some((x) => x.path === e.path),
    });
  });
  return rows;
}

export function analyse(dataDir, runDirs, corpus) {
  const rows = [];
  const knownPaths = [...corpus.keys()];
  for (const run of runDirs) {
    const traces = loadTraces(dataDir, run, knownPaths);
    const chosen = chooseBlobs(traces, corpus, RUN_REF[run] ?? DEFAULT_REF);
    for (const { t, events } of traces) rows.push(...traceRows(run, t, events, chosen));
    process.stderr.write(`${run}: ${traces.length} traces\n`);
  }
  return rows;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [dataDir, out, ...runs] = process.argv.slice(2);
  if (!dataDir || !out) {
    console.error('usage: skill-reads.mjs <data-dir> <out.jsonl> [run-dir ...]');
    process.exit(2);
  }
  const runDirs = runs.length ? runs : readdirSync(dataDir).filter((d) => d.startsWith('run-'));
  const rows = analyse(dataDir, runDirs, loadCorpus());
  writeFileSync(out, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.error(`${rows.length} read events → ${out}`);
}
