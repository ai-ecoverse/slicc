#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { listFiles } from './publish.mjs';
import { writeOutputs } from './run.mjs';

const REBUILT = new Set([
  'records',
  'traces',
  'results',
  'report.md',
  'report.json',
  'report.html',
]);

const readRecord = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};
const judged = (r) => typeof r?.score === 'number' && !r.error;

function mergeRecords(shard, out) {
  const unreadable = [];
  const from = join(shard, 'records');
  for (const f of listFiles(from)) {
    const src = join(from, f);
    const dest = join(out, 'records', f);
    const record = readRecord(src);
    if (!record) {
      unreadable.push(join(basename(shard), 'records', f));
      continue;
    }
    if (existsSync(dest) && (judged(readRecord(dest)) || !judged(record))) continue;
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest);
  }
  return unreadable;
}

function runStartOf(shard) {
  try {
    return JSON.parse(readFileSync(join(shard, 'report.json'), 'utf8')).run_start ?? null;
  } catch {
    return null;
  }
}

export function mergeShards(shards, out) {
  mkdirSync(out, { recursive: true });
  const starts = [];
  const unreadable = [];
  const names = new Set();
  for (const shard of shards) {
    let name = basename(shard);
    while (names.has(name)) name = `${name}+`;
    names.add(name);
    unreadable.push(...mergeRecords(shard, out));
    if (existsSync(join(shard, 'traces')))
      cpSync(join(shard, 'traces'), join(out, 'traces'), { recursive: true, force: false });
    for (const e of readdirSync(shard)) {
      if (REBUILT.has(e)) continue;
      const src = join(shard, e);
      cpSync(src, join(out, 'shards', name, e), { recursive: statSync(src).isDirectory() });
    }
    const start = runStartOf(shard);
    if (start) starts.push(start);
  }
  const runStart = starts.sort()[0] ?? new Date().toISOString();
  writeOutputs({ out }, runStart);
  return {
    shards: shards.length,
    records: listFiles(join(out, 'records')).length,
    runStart,
    unreadable,
  };
}

export function main(argv = process.argv.slice(2), { log = console.error } = {}) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { out: { type: 'string' } },
    allowPositionals: true,
  });
  if (!values.out) throw new Error('give --out, the merged out dir, then the shard out dirs');
  const shards = positionals.map((p) => resolve(p)).filter((p) => existsSync(p));
  if (!shards.length) throw new Error('no shard out dirs to merge');
  const got = mergeShards(shards, resolve(values.out));
  log(`merged ${got.shards} shard(s): ${got.records} record(s), run start ${got.runStart}`);
  for (const f of got.unreadable) log(`left out ${f}: not valid JSON`);
  return 0;
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
/* v8 ignore next 8 */
if (isMain) {
  try {
    process.exit(main());
  } catch (err) {
    console.error(`merge: ${err.message}`);
    process.exit(1);
  }
}
