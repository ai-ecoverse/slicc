#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fromSkillCreatorEvals, pathSegment, validateEnvelope } from './format.mjs';
import { reportData, reportMarkdown, summarize } from './results.mjs';
import { encryptJson, UPSTREAM_SETS } from './upstream.mjs';

export const DATASET = 'ai-ecoverse/slicc-bench';
export const CARD_TEMPLATE = new URL('../dataset/README.md', import.meta.url);
export const REPORT_MARKER = '<!-- report -->';
const BUILTIN_SETS = new Set(['bu-v1', 'bu-v2']);
const UPSTREAM_SEGMENTS = new Set(UPSTREAM_SETS.map(pathSegment));

export function parsePublishCli(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      out: { type: 'string' },
      stage: { type: 'string' },
      run: { type: 'string' },
      dataset: { type: 'string' },
      set: { type: 'string', multiple: true },
    },
  });
  if (!values.stage) throw new Error('give --stage, the directory to upload');
  if (values.out && !/^[A-Za-z0-9._-]+$/.test(values.run ?? ''))
    throw new Error('give --run, a name for this run (letters, digits, . _ -)');
  if (!values.out && !values.dataset) throw new Error('give --out, --dataset, or both');
  return {
    out: values.out ? resolve(values.out) : null,
    stage: resolve(values.stage),
    run: values.run ?? null,
    dataset: values.dataset ? resolve(values.dataset) : null,
    sets: values.set ?? [],
  };
}

export function listFiles(dir) {
  if (!existsSync(dir)) return [];
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else files.push(relative(dir, p));
    }
  };
  walk(dir);
  return files.sort();
}

function put(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

export function publicRecord(r) {
  let out = { ...r };
  if (out.metrics?.tabs) {
    const { tabs: _tabs, ...metrics } = out.metrics;
    out.metrics = metrics;
  }
  if (!UPSTREAM_SETS.includes(r.benchmark)) return out;

  out = redactCriteria(out);
  if (!r.statuses) return out;
  const counts = {};
  for (const status of Object.values(r.statuses)) counts[status] = (counts[status] ?? 0) + 1;
  delete out.statuses;
  return { ...out, status_counts: counts };
}

const CRITERION_ID = /\b[A-Z]\d{1,3}_[A-Za-z0-9_]+/g;

export function redactCriteria(value) {
  if (typeof value === 'string') return value.replace(CRITERION_ID, '[criterion]');
  if (Array.isArray(value)) return value.map(redactCriteria);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, k === 'statuses' ? v : redactCriteria(v)])
    );
  return value;
}

export function readJsonFile(path, { log = console.error } = {}) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    log(`publish: skipping unreadable ${path}: ${err.message}`);
    return null;
  }
}

export function recordsIn(root, { log = console.error, skipped = null } = {}) {
  const dir = join(root, 'records');
  const entries = [];
  for (const f of listFiles(dir).filter((name) => name.endsWith('.json'))) {
    const path = join(dir, f);
    const raw = readJsonFile(path, { log });
    if (!raw) {
      skipped?.push(f);
      continue;
    }
    entries.push([f, publicRecord(raw)]);
  }
  return new Map(entries);
}

export function publishableTraces(out, { log = console.error, skipped = null } = {}) {
  const dir = join(out, 'traces');
  const traces = [];
  for (const f of listFiles(dir)) {
    if (f.endsWith('.enc') || UPSTREAM_SEGMENTS.has(f.split(/[\\/]/)[0])) continue;
    const path = join(dir, f);
    const trace = readJsonFile(path, { log });
    if (!trace) {
      skipped?.push(f);
      continue;
    }
    traces.push({ path: `${f}.enc`, text: encryptJson(trace, trace.record.benchmark) });
  }
  return traces;
}

export function taskSetEnvelope(spec, readFile = readFileSync) {
  if (BUILTIN_SETS.has(spec)) return null;
  const doc = JSON.parse(readFile(spec, 'utf8'));
  const envelope = Array.isArray(doc.evals) ? fromSkillCreatorEvals(doc) : doc;
  const errors = validateEnvelope(envelope);
  if (errors.length) throw new Error(`${spec}: ${errors[0]}`);
  if (UPSTREAM_SETS.includes(envelope.benchmark))
    throw new Error(`${spec}: ${envelope.benchmark} is browser-use's set, not ours to publish`);
  return envelope;
}

export function datasetCard(template, records) {
  if (!template.includes(REPORT_MARKER)) throw new Error(`card template lacks ${REPORT_MARKER}`);
  const report = records.length
    ? reportMarkdown(records, { title: 'Latest results' })
    : '## Latest results\n\nNo runs published yet.\n';
  return template.replace(REPORT_MARKER, report.trim());
}

function writeCombined(stage, records, template) {
  for (const s of summarize(records)) put(join(stage, 'results', s.file), json(s.body));
  put(join(stage, 'report.md'), `${reportMarkdown(records).trim()}\n`);
  put(join(stage, 'report.json'), json(reportData(records)));
  put(join(stage, 'README.md'), datasetCard(template, records));
}

function stageRun(opts, stage, { log = console.error } = {}) {
  const base = join(stage, 'runs', opts.run);
  const skippedRecords = [];
  const own = recordsIn(opts.out, { log, skipped: skippedRecords });
  for (const [f, r] of own) put(join(base, 'records', f), json(r));

  const upstreamFile = (f) => UPSTREAM_SETS.some((b) => f.includes(`_bench_${pathSegment(b)}`));
  const hasUpstream = [...own.values()].some((r) => UPSTREAM_SETS.includes(r.benchmark));
  const copy = (from, to, redact) => {
    const text = readFileSync(from, 'utf8');
    put(to, redact ? redactCriteria(text) : text);
  };
  for (const f of listFiles(join(opts.out, 'results')))
    copy(join(opts.out, 'results', f), join(base, 'results', f), upstreamFile(f));
  for (const f of ['report.md', 'report.json']) {
    if (existsSync(join(opts.out, f))) copy(join(opts.out, f), join(base, f), hasUpstream);
  }
  const skippedTraces = [];
  const traces = publishableTraces(opts.out, { log, skipped: skippedTraces });
  for (const t of traces) put(join(base, 'traces', t.path), t.text);
  return {
    records: own,
    traces: traces.length,
    skippedRecords: skippedRecords.length,
    skippedTraces: skippedTraces.length,
  };
}

export function dropStaleUpstreamRecords(merged, incoming) {
  const pins = new Map();
  for (const r of incoming.values()) {
    if (r.upstream?.commit) pins.set(r.benchmark, r.upstream.commit);
  }
  if (!pins.size) return [];
  const dropped = [];
  for (const [f, r] of [...merged]) {
    const pin = pins.get(r.benchmark);
    if (!pin || r.upstream?.commit === pin) continue;
    merged.delete(f);
    dropped.push(f);
  }
  return dropped;
}

export function preserveSkippedDatasetRecords(
  dataset,
  stage,
  skipped,
  { overwritten = new Set() } = {}
) {
  let preserved = 0;
  for (const f of skipped) {
    if (overwritten.has(f)) continue;
    const src = join(dataset, 'records', f);
    if (!existsSync(src)) continue;
    const dest = join(stage, 'records', f);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest);
    preserved++;
  }
  return preserved;
}

export function stage(opts, { readFile = readFileSync, log = console.error } = {}) {
  const template = readFile(CARD_TEMPLATE, 'utf8');
  const skippedDataset = [];
  const merged = opts.dataset
    ? recordsIn(opts.dataset, { log, skipped: skippedDataset })
    : new Map();
  let run = { records: new Map(), traces: 0, skippedRecords: 0, skippedTraces: 0 };
  let dropped = [];
  let preserved = 0;
  if (opts.out) {
    run = stageRun(opts, opts.stage, { log });
    dropped = dropStaleUpstreamRecords(merged, run.records);
    for (const [f, r] of run.records) merged.set(f, r);

    for (const [f, r] of merged) put(join(opts.stage, 'records', f), json(r));

    if (opts.dataset && skippedDataset.length) {
      preserved = preserveSkippedDatasetRecords(opts.dataset, opts.stage, skippedDataset, {
        overwritten: new Set(run.records.keys()),
      });
      if (preserved) log(`publish: preserved ${preserved} unreadable Hub record(s) for upload`);
    }
  }
  const taskSets = [];
  for (const spec of opts.sets) {
    const envelope = taskSetEnvelope(spec, readFile);
    if (!envelope) continue;
    const name = pathSegment(envelope.benchmark);
    put(join(opts.stage, 'tasks', `${name}.enc`), encryptJson(envelope, envelope.benchmark));
    taskSets.push(name);
  }
  writeCombined(opts.stage, [...merged.values()], template);
  return {
    records: run.records.size,
    traces: run.traces,
    combined: merged.size,
    dropped: dropped.length,
    skipped: skippedDataset.length + (run.skippedRecords ?? 0) + (run.skippedTraces ?? 0),
    preserved,
    taskSets,
  };
}

export function main(argv = process.argv.slice(2), { log = console.error } = {}) {
  const opts = parsePublishCli(argv);
  const s = stage(opts, { log });
  log(
    `staged ${s.records} run record(s), ${s.traces} encrypted trace(s), ${s.combined} record(s) in the combined report` +
      (s.dropped ? `, dropped ${s.dropped} from an earlier upstream pin` : '') +
      (s.skipped ? `, skipped ${s.skipped} unreadable` : '') +
      (s.preserved ? `, preserved ${s.preserved} for Hub replace` : '') +
      (s.taskSets.length ? `, task sets ${s.taskSets.join(', ')}` : '')
  );
  return 0;
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
/* v8 ignore next 8 */
if (isMain) {
  try {
    process.exit(main());
  } catch (err) {
    console.error(`publish: ${err.message}`);
    process.exit(1);
  }
}
