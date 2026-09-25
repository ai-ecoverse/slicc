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

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  const out = { ...r };
  if (out.metrics?.tabs) {
    const { tabs: _tabs, ...metrics } = out.metrics;
    out.metrics = metrics;
  }
  if (!UPSTREAM_SETS.includes(r.benchmark) || !r.statuses) return out;
  const counts = {};
  for (const status of Object.values(r.statuses)) counts[status] = (counts[status] ?? 0) + 1;
  delete out.statuses;
  return { ...out, status_counts: counts };
}

/** Records by their path under `records/`. */
function recordsIn(root) {
  const dir = join(root, 'records');
  return new Map(
    listFiles(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => [f, publicRecord(JSON.parse(readFileSync(join(dir, f), 'utf8')))])
  );
}

/**
 * This run's traces, ready to publish: encrypted with their own set's key, upstream sets left
 * out. A trace written encrypted (`.enc`) is always an upstream set's.
 */
export function publishableTraces(out) {
  const dir = join(out, 'traces');
  const traces = [];
  for (const f of listFiles(dir)) {
    if (f.endsWith('.enc') || UPSTREAM_SEGMENTS.has(f.split(/[\\/]/)[0])) continue;
    const trace = JSON.parse(readFileSync(join(dir, f), 'utf8'));
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

function stageRun(opts, stage) {
  const base = join(stage, 'runs', opts.run);
  const own = recordsIn(opts.out);
  for (const [f, r] of own) put(join(base, 'records', f), json(r));
  for (const f of listFiles(join(opts.out, 'results')))
    put(join(base, 'results', f), readFileSync(join(opts.out, 'results', f)));
  for (const f of ['report.md', 'report.json']) {
    if (existsSync(join(opts.out, f))) put(join(base, f), readFileSync(join(opts.out, f)));
  }
  const traces = publishableTraces(opts.out);
  for (const t of traces) put(join(base, 'traces', t.path), t.text);
  return { records: own, traces: traces.length };
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
 * Stage everything for one upload. Returns what was staged, for the log. The combined files
 * come from the dataset's records with this run's laid over them: a rerun of a configuration
 * replaces its earlier records. Advancing an upstream pin drops the previous pin's records for
 * that benchmark so a partial shard does not mix task versions in the report.
 */
export function stage(opts, { readFile = readFileSync } = {}) {
  const template = readFile(CARD_TEMPLATE, 'utf8');
  const merged = opts.dataset ? recordsIn(opts.dataset) : new Map();
  let run = { records: new Map(), traces: 0 };
  let dropped = [];
  if (opts.out) {
    run = stageRun(opts, opts.stage);
    dropped = dropStaleUpstreamRecords(merged, run.records);
    for (const [f, r] of run.records) merged.set(f, r);
    // Write the full cleaned set so `hf upload --delete 'records/**'` replaces the Hub's
    // records tree (a pin advance must not leave the previous pin's unfinished tasks).
    for (const [f, r] of merged) put(join(opts.stage, 'records', f), json(r));
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
    taskSets,
  };
}

export function main(argv = process.argv.slice(2), { log = console.error } = {}) {
  const opts = parsePublishCli(argv);
  const s = stage(opts);
  log(
    `staged ${s.records} run record(s), ${s.traces} encrypted trace(s), ${s.combined} record(s) in the combined report` +
      (s.dropped ? `, dropped ${s.dropped} from an earlier upstream pin` : '') +
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
