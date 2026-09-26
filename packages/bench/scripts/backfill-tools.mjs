#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { listFiles } from './publish.mjs';
import { readTrace, recordPath } from './run.mjs';
import { toolMetrics } from './slicc-adapter.mjs';
import { encryptJson } from './upstream.mjs';

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

const exactKey = (benchmark, taskId, model, skills, repeat) =>
  `${benchmark}|${taskId}|${model}|${skills}|${repeat}`;
const legacyKey = (taskId, model, skills) => `${taskId}|${model}|${skills}`;

export function taskVersions(eventsText) {
  const current = new Map();
  const exact = new Map();
  const legacy = new Map();
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
    else if (e.type === 'start' && e.slicc_version) current.set(0, e.slicc_version);
    else if (e.type === 'task' && e.task_id) {
      const v = e.leader?.slicc_version ?? current.get(lane) ?? null;
      if (e.benchmark && e.repeat != null)
        exact.set(exactKey(e.benchmark, e.task_id, e.model, e.skills, e.repeat), v);
      else {
        const k = legacyKey(e.task_id, e.model, e.skills);
        legacy.set(k, [...(legacy.get(k) ?? []), v]);
      }
    }
  }
  return { exact, legacy };
}

function legacyVersion(versions, records) {
  if (!versions?.length) return { v: null };
  if (records === 1) return { v: versions.at(-1) };
  return new Set(versions).size === 1 ? { v: versions[0] } : { v: null, ambiguous: true };
}

export function backfillVersions(out) {
  const file = join(out, 'events.jsonl');
  if (!existsSync(file)) return { stamped: 0, unknown: 0, ambiguous: 0 };
  const { exact, legacy } = taskVersions(readFileSync(file, 'utf8'));
  const root = join(out, 'records');
  const records = (existsSync(root) ? listFiles(root) : []).map((f) => {
    const path = join(root, f);
    return { path, record: JSON.parse(readFileSync(path, 'utf8')) };
  });
  const sharing = new Map();
  for (const { record: r } of records) {
    const k = legacyKey(r.task_id, r.config?.model, r.config?.skills);
    sharing.set(k, (sharing.get(k) ?? 0) + 1);
  }
  let stamped = 0;
  let unknown = 0;
  let ambiguous = 0;
  for (const { path, record } of records) {
    if (record.leader?.slicc_version) continue;
    const { model, skills } = record.config ?? {};
    const full = exactKey(record.benchmark, record.task_id, model, skills, record.repeat);
    const k = legacyKey(record.task_id, model, skills);
    const found = exact.has(full)
      ? { v: exact.get(full) }
      : legacyVersion(legacy.get(k), sharing.get(k));
    const v = found.v;
    if (found.ambiguous) ambiguous += 1;
    if (!v) {
      unknown += 1;
      continue;
    }
    record.leader = { ...record.leader, slicc_version: v };
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
    stamped += 1;
  }
  return { stamped, unknown, ambiguous };
}

export function main(argv = process.argv.slice(2), { log = console.error } = {}) {
  const { values } = parseArgs({ args: argv, options: { out: { type: 'string' } } });
  if (!values.out) throw new Error('give --out, a run out dir with records/ and traces/');
  const out = resolve(values.out);
  const { updated, unknown } = backfillTools(out);
  log(`backfilled ${updated} run(s); ${unknown} without a transcript to count (left unknown)`);
  const v = backfillVersions(out);
  log(
    `stamped the SLICC version on ${v.stamped} record(s); ${v.unknown} left unknown (${v.ambiguous} ambiguous: runs sharing a task, model and skills in an older journal)`
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
