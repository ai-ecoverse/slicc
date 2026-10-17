#!/usr/bin/env node
/**
 * publish — stage a benchmark run for the SLICC benchmark dataset on Hugging Face
 * (ai-ecoverse/slicc-bench), in browser-use/benchmark's conventions. `hf upload` sends the
 * staged directory as one commit.
 *
 *   node packages/bench/scripts/publish.mjs --out bench-out --stage hf-stage --run 20260924-123 \
 *     --dataset hf-current --set packages/bench/tasks/smoke.json
 *
 * `--dataset` is a download of the dataset's current `records/`, so the combined report covers
 * every configuration published so far, not just this run's. Without `--out`, only the combined
 * files are rebuilt from `--dataset`.
 *
 * Staged layout:
 *   README.md                dataset card, with the combined report
 *   report.md, report.json   the combined report
 *   results/*.json           one browser-use-style result file per configuration
 *   records/…                the latest record per task, configuration and repeat (no task text)
 *   tasks/<benchmark>.enc    our own task sets: base64 of a Fernet token, key sha256(<benchmark>)
 *   runs/<run>/              this run: records, results, report, and its traces, encrypted
 *
 * Upstream sets (BU Bench) publish scores only. Their traces hold browser-use's task text, and
 * that repo has no licence and asks for the text never to be published.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

/** Every file under `dir`, as paths relative to it; none when `dir` is missing. */
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

/**
 * A record as published. The tabs left open can name the site or the search, so they stay in
 * the encrypted trace. Upstream sets' rubric item ids are browser-use's own and can hint at the
 * task, so their per-item statuses become counts.
 */
export function publicRecord(r) {
  let out = { ...r };
  if (out.metrics?.tabs) {
    const { tabs: _tabs, ...metrics } = out.metrics;
    out.metrics = metrics;
  }
  if (!UPSTREAM_SETS.includes(r.benchmark)) return out;
  // Rubric item ids also surface in free text (a judge's fallback reason names the findings
  // it could not assess): redact them everywhere, not only in `statuses`.
  out = redactCriteria(out);
  if (!r.statuses) return out;
  const counts = {};
  for (const status of Object.values(r.statuses)) counts[status] = (counts[status] ?? 0) + 1;
  delete out.statuses;
  return { ...out, status_counts: counts };
}

/** A rubric item id as browser-use writes them: `A5_line_fields`, `B12_total`. */
const CRITERION_ID = /\b[A-Z]\d{1,3}_[A-Za-z0-9_]+/g;

/** A copy with every rubric item id in a string replaced by `[criterion]`. */
export function redactCriteria(value) {
  if (typeof value === 'string') return value.replace(CRITERION_ID, '[criterion]');
  if (Array.isArray(value)) return value.map(redactCriteria);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, k === 'statuses' ? v : redactCriteria(v)])
    );
  return value;
}

/**
 * Parse one JSON file; return null on corrupt/truncated input.
 * Mirrors `merge.mjs` `readRecord` — one Hub glitch must not abort publish (#3961).
 */
export function readJsonFile(path, { log = console.error } = {}) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    log(`publish: skipping unreadable ${path}: ${err.message}`);
    return null;
  }
}

/**
 * Records by their path under `records/`. Unreadable files are skipped (logged) rather than
 * failing the whole stage — Hub downloads are unfiltered (#3961).
 */
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

/**
 * This run's traces, ready to publish: encrypted with their own set's key, upstream sets left
 * out. A trace written encrypted (`.enc`) is always an upstream set's. Unreadable plain traces
 * are skipped (logged) rather than aborting publish (#3961).
 */
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

/** A task-set file as the envelope to publish; null for upstream sets, which are not ours. */
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
  // The run's own result files and report are copied, not rebuilt: redact rubric item ids in
  // the ones that cover an upstream set (a failed judge's error can name a finding).
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

/**
 * Drop dataset records for an upstream benchmark whose pin this run advances. A partial first
 * publish of a new pin would otherwise leave the previous pin's unfinished tasks in the
 * combined report, mixed with the new ones under the same benchmark/model/skills group.
 * Returns the relative paths removed from `merged` (under `records/`).
 */
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

/**
 * Copy Hub dataset files that failed to parse into the stage tree so
 * `hf upload --delete 'records/**'` does not permanently remove a remote record that was only
 * unreadable in this download (truncated local copy / transient glitch). Paths this run already
 * replaced are left alone.
 */
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

/**
 * Stage everything for one upload. Returns what was staged, for the log. The combined files
 * come from the dataset's records with this run's laid over them: a rerun of a configuration
 * replaces its earlier records. Advancing an upstream pin drops the previous pin's records for
 * that benchmark so a partial shard does not mix task versions in the report.
 */
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
    // Write the full cleaned set so `hf upload --delete 'records/**'` replaces the Hub's
    // records tree (a pin advance must not leave the previous pin's unfinished tasks).
    for (const [f, r] of merged) put(join(opts.stage, 'records', f), json(r));
    // Unreadable Hub downloads stay out of the combined report but must remain in the staged
    // tree — otherwise --delete wipes a healthy remote record that only failed locally (#3961).
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
  process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
/* v8 ignore next 8 */
if (isMain) {
  try {
    process.exit(main());
  } catch (err) {
    console.error(`publish: ${err.message}`);
    process.exit(1);
  }
}
