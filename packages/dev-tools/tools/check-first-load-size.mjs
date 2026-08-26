#!/usr/bin/env node
/**
 * First-load (cold-cache boot) size gate for the webapp.
 *
 * Run after `npm run build -w @slicc/webapp`; part of the webapp `size`
 * script alongside size-limit's total-JS-payload cap. Measures the EAGER
 * import closures the browser must fetch before the app is interactive —
 * the page entry graph (from `.vite/manifest.json`) and the kernel worker
 * graph (parsed from the emitted ES chunks, which the manifest does not
 * cover).
 *
 * The gate is RELATIVE. It builds the merge-base in a throwaway worktree,
 * measures it the same way on the same machine, and fails when the change
 * adds more than `maxDeltaKb` to either graph. An absolute ceiling from
 * `packages/webapp/first-load-budget.json` backs it up so many small
 * under-threshold changes cannot creep the graph upward forever.
 *
 * The delta is a PER-PULL-REQUEST check and is deliberately not applied to a
 * merge-queue batch. A `merge_group` branch is cumulative — it carries every
 * PR up to its position in the queue, so its delta is the SUM of the batch,
 * not one change's growth. Applying a per-change allowance to it fails on
 * queue depth: observed batches reached +3.8 kB against a 4 kB allowance
 * while the individual PRs measured 0.1-1.9 kB, and a merge_group failure
 * DEQUEUES green PRs. On `merge_group` the ceilings are the right check —
 * they are exactly the guard against accumulated growth.
 *
 * That split only holds if the per-PR delta is actually enforced upstream of
 * the queue, so a `pull_request` run in CI treats an unmeasurable baseline as
 * a FAILURE rather than degrading to ceilings-only. Otherwise a PR whose
 * baseline build broke would sail through both stages with its delta never
 * checked. Outside CI the graceful degradation stays: a developer on a
 * shallow clone should get the ceilings and a clear note, not a hard stop.
 *
 * It used to be an absolute ratchet, and that shape failed: the number was
 * set to main's exact measurement, main measured 1 kB larger on Linux CI
 * than on the macOS machines developers verify on, and so every webapp PR
 * inherited a red gate it had not caused and patched the same line to the
 * minimum that cleared. Three PRs (#2422, #2436, #2438) all measured
 * exactly main's number, all raised the line, and all conflicted with each
 * other. A relative gate fails only changes that actually regress, and
 * cancels the platform difference by construction.
 *
 * Usage:
 *   node check-first-load-size.mjs [options]
 *     --baseline=<ref>  compare against the merge-base with <ref>
 *                       (default: origin/main; `--baseline=none` disables)
 *     --json            print measured bytes as JSON and exit 0, no gating
 *
 * `GITHUB_EVENT_NAME=merge_group` forces ceilings-only, as above.
 */

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
const baselineRef = (
  args.find((a) => a.startsWith('--baseline=')) ?? '--baseline=origin/main'
).slice('--baseline='.length);
// A merge-queue batch is not "a change" — see the header. Ceilings only.
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

/** Sum the eager closures of both graphs for one built `dist/ui`, in bytes. */
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
      return null; // lookalike specifier inside string content — ignore
    }
  });
  const sum = (files, baseDir) =>
    files.reduce((bytes, f) => bytes + statSync(resolve(baseDir, f)).size, 0);
  return {
    // Page-graph files are relative to dist/ui (manifest `file` values);
    // worker-graph files are bare names inside dist/ui/assets.
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

// In CI on a pull request the baseline is not optional: degrading to
// ceilings-only there would let the change reach the merge queue, which
// deliberately does not re-check the delta, with its growth never measured.
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
