#!/usr/bin/env node
/**
 * First-load (cold-cache boot) size ratchet for the webapp.
 *
 * Run after `npm run build -w @slicc/webapp`; part of the webapp `size`
 * script alongside size-limit's total-JS-payload cap. Measures the EAGER
 * import closures the browser must fetch before the app is interactive —
 * the page entry graph (from `.vite/manifest.json`) and the kernel worker
 * graph (parsed from the emitted ES chunks, which the manifest does not
 * cover) — and compares them against `packages/webapp/first-load-budget.json`.
 *
 * The budgets are ratchets: tighten them as the eager graphs shrink;
 * raising one needs a reason in the PR body. This replaces the old
 * per-file `kernel worker` / `main entry chunk` size-limit entries, which
 * measured single chunks rather than what a first-time user downloads —
 * a static import that hoists an existing lazy chunk into the boot graph
 * changed neither of those numbers but regressed cold-boot latency.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkBudgets, chunkEagerClosure, manifestEagerClosure } from './first-load-size-lib.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const uiDir = resolve(repoRoot, 'dist/ui');
const assetsDir = resolve(uiDir, 'assets');
const budgetPath = resolve(repoRoot, 'packages/webapp/first-load-budget.json');

const PAGE_ENTRY_KEY = 'packages/webapp/index.html';
const WORKER_ENTRY_PREFIX = 'kernel-worker-';

function fail(message) {
  console.error(`check-first-load-size: ${message}`);
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(resolve(uiDir, '.vite/manifest.json'), 'utf8'));
} catch {
  fail(`could not read ${uiDir}/.vite/manifest.json — build the webapp first`);
}

const budgets = JSON.parse(readFileSync(budgetPath, 'utf8'));

// ── Page graph (manifest walk) ──────────────────────────────────────
const pageFiles = manifestEagerClosure(manifest, PAGE_ENTRY_KEY);

// ── Worker graph (emitted-chunk walk) ───────────────────────────────
const workerEntry = readdirSync(assetsDir).find(
  (f) => f.startsWith(WORKER_ENTRY_PREFIX) && f.endsWith('.js')
);
if (!workerEntry) fail(`no ${WORKER_ENTRY_PREFIX}*.js in ${assetsDir}`);
const workerFiles = chunkEagerClosure(workerEntry, (file) => {
  try {
    return readFileSync(resolve(assetsDir, file), 'utf8');
  } catch {
    return null; // lookalike specifier inside string content — ignore
  }
});

function totalKb(files, baseDir) {
  let bytes = 0;
  for (const f of files) bytes += statSync(resolve(baseDir, f)).size;
  return Math.round(bytes / 1024);
}

function report(label, files, baseDir) {
  const rows = files
    .map((f) => ({ f, kb: Math.round(statSync(resolve(baseDir, f)).size / 1024) }))
    .sort((a, b) => b.kb - a.kb);
  console.log(`  ${label}: ${rows.length} chunks — top contributors:`);
  for (const { f, kb } of rows.slice(0, 8)) console.log(`    ${String(kb).padStart(6)} kB  ${f}`);
}

const measured = {
  // Page-graph files are relative to dist/ui (manifest `file` values);
  // worker-graph files are bare names inside dist/ui/assets.
  pageEagerKb: totalKb(pageFiles, uiDir),
  workerEagerKb: totalKb(workerFiles, assetsDir),
};

console.log(
  `First-load eager payload: page ${measured.pageEagerKb} kB ` +
    `(budget ${budgets.pageEagerKb}), worker ${measured.workerEagerKb} kB ` +
    `(budget ${budgets.workerEagerKb})`
);
report('page graph', pageFiles, uiDir);
report('worker graph', workerFiles, assetsDir);

const { failures, ratchetHints } = checkBudgets(budgets, measured);
for (const hint of ratchetHints) console.log(`  note: ${hint}`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`  FAIL: ${failure}`);
  process.exit(1);
}
console.log('First-load budgets OK.');
