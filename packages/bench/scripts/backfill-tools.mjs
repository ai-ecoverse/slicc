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

export function main(argv = process.argv.slice(2), { log = console.error } = {}) {
  const { values } = parseArgs({ args: argv, options: { out: { type: 'string' } } });
  if (!values.out) throw new Error('give --out, a run out dir with records/ and traces/');
  const { updated, unknown } = backfillTools(resolve(values.out));
  log(`backfilled ${updated} run(s); ${unknown} without a transcript to count (left unknown)`);
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
