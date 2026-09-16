#!/usr/bin/env node

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { measureMergeBase } from './first-load-baseline.mjs';
import {
  bytesToKb,
  checkFirstLoad,
  chunkEagerClosure,
  manifestEagerClosure,
} from './first-load-size-lib.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const limitsPath = resolve(repoRoot, 'packages/webapp/first-load-budget.json');

const PAGE_ENTRY_KEY = 'packages/webapp/index.html';
const WORKER_ENTRY_PREFIX = 'kernel-worker-';

const args = process.argv.slice(2);
const jsonOnly = args.includes('--json');
const defaultBaseline = process.env.GITHUB_BASE_REF
  ? `origin/${process.env.GITHUB_BASE_REF}`
  : 'origin/main';
const baselineRef = (
  args.find((a) => a.startsWith('--baseline=')) ?? `--baseline=${defaultBaseline}`
).slice('--baseline='.length);

const isMergeGroup = process.env.GITHUB_EVENT_NAME === 'merge_group';
const isCiPullRequest = process.env.GITHUB_EVENT_NAME === 'pull_request';
const MERGE_GROUP_NOTE =
  'merge_group: a queue batch is cumulative (every PR up to its position), so the per-change ' +
  'delta does not apply here — the absolute ceilings are the queue-stage check. The per-change ' +
  'delta is enforced on the pull_request run, which fails outright if it cannot measure.';

function fail(message) {
  console.error(`check-first-load-size: ${message}`);
  process.exit(1);
}

function measureUiDir(uiDir) {
  const assetsDir = resolve(uiDir, 'assets');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(resolve(uiDir, '.vite/manifest.json'), 'utf8'));
  } catch {
    throw new Error(`could not read ${uiDir}/.vite/manifest.json — build the webapp first`);
  }
  const workerEntry = readdirSync(assetsDir).find(
    (f) => f.startsWith(WORKER_ENTRY_PREFIX) && f.endsWith('.js')
  );
  if (!workerEntry) throw new Error(`no ${WORKER_ENTRY_PREFIX}*.js in ${assetsDir}`);

  const pageFiles = manifestEagerClosure(manifest, PAGE_ENTRY_KEY);
  const workerFiles = chunkEagerClosure(workerEntry, (file) => {
    try {
      return readFileSync(resolve(assetsDir, file), 'utf8');
    } catch {
      return null;
    }
  });
  const sum = (files, baseDir) =>
    files.reduce((bytes, f) => bytes + statSync(resolve(baseDir, f)).size, 0);
  return {
    page: sum(pageFiles, uiDir),
    worker: sum(workerFiles, assetsDir),
    files: { page: pageFiles, worker: workerFiles },
    dirs: { page: uiDir, worker: assetsDir },
  };
}

function report(label, files, baseDir) {
  const rows = files
    .map((f) => ({ f, kb: Math.round(statSync(resolve(baseDir, f)).size / 1024) }))
    .sort((a, b) => b.kb - a.kb);
  console.log(`  ${label}: ${rows.length} chunks — top contributors:`);
  for (const { f, kb } of rows.slice(0, 8)) console.log(`    ${String(kb).padStart(6)} kB  ${f}`);
}

let head;
try {
  head = measureUiDir(resolve(repoRoot, 'dist/ui'));
} catch (err) {
  fail(err.message);
}

if (jsonOnly) {
  console.log(JSON.stringify({ page: head.page, worker: head.worker }));
  process.exit(0);
}

const limits = JSON.parse(readFileSync(limitsPath, 'utf8'));

let baseline = null;
if (baselineRef !== 'none' && !isMergeGroup) {
  console.log(`Measuring the merge-base with ${baselineRef} for comparison…`);
  baseline = measureMergeBase({
    repoRoot,
    ref: baselineRef,
    measure: (uiDir) => {
      const m = measureUiDir(uiDir);
      return { page: m.page, worker: m.worker };
    },
    log: (m) => console.log(`  baseline: ${m}`),
  });
}

if (!isMergeGroup && baselineRef !== 'none' && !baseline && isCiPullRequest) {
  fail(
    `could not measure the merge-base with "${baselineRef}", so the per-change delta could ` +
      `not be checked. The merge queue does not re-check it, so this cannot be waved through. ` +
      `See the baseline log above; re-run if it was transient.`
  );
}

const { failures, notes, rows } = checkFirstLoad(limits, head, baseline?.bytes ?? null, {
  baselineNote: isMergeGroup ? MERGE_GROUP_NOTE : undefined,
});

console.log(
  `First-load eager payload${baseline ? ` (vs merge-base ${baseline.sha.slice(0, 8)})` : ''}:`
);
for (const row of rows) {
  const delta =
    row.deltaKb === null
      ? 'baseline n/a'
      : `${row.deltaKb >= 0 ? '+' : ''}${row.deltaKb.toFixed(1)} kB vs base`;
  const ceiling = row.ceiling === null ? 'no ceiling' : `${row.headroomKb} kB under ceiling`;
  console.log(`  ${row.graph.padEnd(6)} ${String(row.kb).padStart(5)} kB — ${delta}, ${ceiling}`);
}
report('page graph', head.files.page, head.dirs.page);
report('worker graph', head.files.worker, head.dirs.worker);

for (const note of notes) console.log(`  note: ${note}`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`  FAIL: ${failure}`);
  process.exit(1);
}
const allowance = isMergeGroup
  ? 'ceilings only on a queue batch'
  : `allowance ${limits.maxDeltaKb} kB per change`;
console.log(
  `First-load OK (${allowance}; total ${bytesToKb(head.page + head.worker)} kB across both graphs).`
);
