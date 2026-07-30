#!/usr/bin/env node
/**
 * Layer-stack back-edge ratchet: no NEW `ui/` imports below the ui layer.
 *
 * The webapp's documented layer stack is
 *   fs → shell/git → cdp → tools → core → scoops → ui
 * Lower layers importing from `ui/` invert the stack and drag DOM-heavy
 * modules into the kernel-worker bundle. The pattern has recurred at least
 * six times (#869, #968, #1071, #1145, #1630, #1772) and was never caught
 * at review time — hence this deterministic gate.
 *
 * Unlike check-no-ui-imports-in-providers.mjs (a zero-tolerance zone),
 * this scan covers ALL of packages/webapp/src/ outside ui/ and enforces a
 * frozen baseline (ui-back-edge-baseline.json): pre-existing back-edges
 * are grandfathered per file, new ones fail, and fixed ones must be
 * removed from the baseline (`--update` regenerates it). The baseline is
 * a one-way ratchet — counts may only go down.
 *
 * Detection reuses the tested helpers from the providers guard.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { argv } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findUiImports } from './check-no-ui-imports-in-providers.mjs';

const Filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(Filename), '..', '..', '..');

const SCAN_ROOT = resolve(repoRoot, 'packages/webapp/src');
const SKIP_DIRS = new Set(['ui']); // ui/ importing ui/ is layer-legal
export const BASELINE_PATH = resolve(dirname(Filename), 'ui-back-edge-baseline.json');

/** A scannable webapp source file (not a test). */
export function isWebappSource(name) {
  return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name);
}

/**
 * File paths listed in a parsed baseline object (its keys). Used by the
 * boy-scout gate (check-touched-exemptions.mjs) to treat the baseline as a
 * debt list. Non-object input yields [].
 */
export function baselineFiles(baseline) {
  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) return [];
  return Object.keys(baseline).filter((k) => typeof k === 'string' && k.length > 0);
}

/** Recursively collect source files under `dir`, skipping SKIP_DIRS at the top level. */
function collect(dir, topLevel = true) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (topLevel && entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const abs = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...collect(abs, false));
    else if (entry.isFile() && isWebappSource(entry.name)) out.push(abs);
  }
  return out;
}

/** Scan the tree; returns `{ 'packages/webapp/src/...': count }` for files with back-edges. */
export function scanBackEdges() {
  const counts = {};
  for (const abs of collect(SCAN_ROOT)) {
    const hits = findUiImports(readFileSync(abs, 'utf8'));
    if (hits.length > 0) counts[relative(repoRoot, abs).split('\\').join('/')] = hits.length;
  }
  return counts;
}

/**
 * Compare `current` counts against `baseline`. Returns a list of failure
 * messages — empty when the tree matches the ratchet.
 */
export function compareToBaseline(current, baseline) {
  const failures = [];
  for (const [file, count] of Object.entries(current)) {
    const allowed = baseline[file] ?? 0;
    if (count > allowed) {
      failures.push(
        `${file}: ${count} ui/ back-edge(s), baseline allows ${allowed} — do not add ` +
          'imports from ui/ below the ui layer; move pure helpers into a lower-layer module instead.'
      );
    } else if (count < allowed) {
      failures.push(
        `${file}: ${count} ui/ back-edge(s), baseline says ${allowed} — thanks for paying ` +
          'debt down! Ratchet the baseline: node packages/dev-tools/tools/check-ui-back-edges.mjs --update'
      );
    }
  }
  for (const file of Object.keys(baseline)) {
    if (!(file in current)) {
      failures.push(
        `${file}: baseline entry is stale (file clean or gone) — run ` +
          'node packages/dev-tools/tools/check-ui-back-edges.mjs --update'
      );
    }
  }
  return failures;
}

function sortedCounts(counts) {
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function main() {
  const current = scanBackEdges();

  if (argv.includes('--update')) {
    writeFileSync(BASELINE_PATH, `${JSON.stringify(sortedCounts(current), null, 2)}\n`);
    const total = Object.values(current).reduce((a, b) => a + b, 0);
    process.stdout.write(
      `baseline updated: ${total} grandfathered ui/ back-edge(s) in ${Object.keys(current).length} file(s)\n`
    );
    return;
  }

  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  const failures = compareToBaseline(current, baseline);

  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`::error::${failure}\n`);
    process.stderr.write(
      `\n${failures.length} layer-stack violation(s). The webapp layer stack ` +
        '(fs → shell/git → cdp → tools → core → scoops → ui) forbids imports from ui/ in ' +
        'lower layers. Move the pure helper below ui/ (see docs/review-patterns.md § ' +
        'Layer-stack import direction) rather than growing the baseline.\n'
    );
    process.exit(1);
  }

  const total = Object.values(current).reduce((a, b) => a + b, 0);
  process.stdout.write(
    `ok: no new ui/ back-edges in packages/webapp/src (${total} grandfathered in ${Object.keys(current).length} baselined files)\n`
  );
}

if (import.meta.url === pathToFileURL(argv[1] ?? '').href) main();
