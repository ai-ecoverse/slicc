#!/usr/bin/env node
/**
 * backfill-tools — add tool-use metrics (`tool_calls`, `tool_kinds`, `web_calls`,
 * `answered_without_tools`) to records written before the runner counted them, from each run's
 * saved trace; and `leader.slicc_version` (the version the run's leader reported at boot) from the
 * out dir's journal, `events.jsonl`, for records written before the runner stamped it.
 *
 *   node packages/bench/scripts/backfill-tools.mjs --out bench-out
 *
 * `--out` is a run's out dir (e.g. a downloaded `bench-<run>` artifact). Each trace is read
 * (decrypted for upstream sets), its transcript counted, and both the record and the trace's copy
 * of it updated; an encrypted trace is re-encrypted with its set's key. A run without a trace keeps
 * its record as it is. Publish afterwards with publish.mjs as usual.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { listFiles } from './publish.mjs';
import { readTrace, recordPath } from './run.mjs';
import { toolMetrics } from './slicc-adapter.mjs';
import { encryptJson } from './upstream.mjs';

/** Backfill every trace under `<out>/traces/`; returns what changed, for the log. */
export function backfillTools(out) {
  const root = join(out, 'traces');
  let updated = 0;
  let unknown = 0;
  for (const f of listFiles(root)) {
    const path = join(root, f);
    const trace = readTrace(path, f.split(/[\\/]/)[0]);
    const r = trace.record;
    const metrics = toolMetrics(trace.result?.transcript);
    if (metrics.tool_calls === null) unknown += 1;
    r.metrics = { ...r.metrics, ...metrics };
    const rp = recordPath(out, r.benchmark, r.config.skills, r.config.model, r.task_id, r.repeat);
    if (existsSync(rp)) {
      const record = JSON.parse(readFileSync(rp, 'utf8'));
      record.metrics = { ...record.metrics, ...metrics };
      writeFileSync(rp, `${JSON.stringify(record, null, 2)}\n`);
    }
    writeFileSync(
      path,
      path.endsWith('.enc') ? encryptJson(trace, r.benchmark) : JSON.stringify(trace)
    );
    updated += 1;
  }
  return { updated, unknown };
}

/**
 * The version each journaled task ran on: the last `leader-ready` of its lane before the task
 * event, keyed `<task_id>|<model>|<skills>`; a later task event (a rerun) replaces an earlier one.
 * A re-judge journals no task event, so it keeps the version of the run it judged.
 */
export function taskVersions(eventsText) {
  const current = new Map();
  const versions = new Map();
  for (const line of String(eventsText).split('\n')) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const lane = e.lane ?? 0;
    if (e.type === 'leader-ready' && e.slicc_version) current.set(lane, e.slicc_version);
    else if (e.type === 'start' && e.slicc_version && !current.has(0))
      current.set(0, e.slicc_version);
    else if (e.type === 'task' && e.task_id)
      versions.set(`${e.task_id}|${e.model}|${e.skills}`, current.get(lane) ?? null);
  }
  return versions;
}

/** Stamp `leader.slicc_version` on records under `<out>/records/` that lack it. */
export function backfillVersions(out) {
  const file = join(out, 'events.jsonl');
  if (!existsSync(file)) return { stamped: 0, unknown: 0 };
  const versions = taskVersions(readFileSync(file, 'utf8'));
  const root = join(out, 'records');
  let stamped = 0;
  let unknown = 0;
  for (const f of existsSync(root) ? listFiles(root) : []) {
    const path = join(root, f);
    const record = JSON.parse(readFileSync(path, 'utf8'));
    if (record.leader?.slicc_version) continue;
    const v = versions.get(`${record.task_id}|${record.config?.model}|${record.config?.skills}`);
    if (!v) {
      unknown += 1;
      continue;
    }
    record.leader = { ...record.leader, slicc_version: v };
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
    stamped += 1;
  }
  return { stamped, unknown };
}

export function main(argv = process.argv.slice(2), { log = console.error } = {}) {
  const { values } = parseArgs({ args: argv, options: { out: { type: 'string' } } });
  if (!values.out) throw new Error('give --out, a run out dir with records/ and traces/');
  const out = resolve(values.out);
  const { updated, unknown } = backfillTools(out);
  log(`backfilled ${updated} run(s); ${unknown} without a transcript to count (left unknown)`);
  const v = backfillVersions(out);
  log(
    `stamped the SLICC version on ${v.stamped} record(s); ${v.unknown} not found in events.jsonl`
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
    console.error(`backfill-tools: ${err.message}`);
    process.exit(1);
  }
}
