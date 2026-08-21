#!/usr/bin/env node
/**
 * `isCone` ratchet (#1666): no NEW role branches in kernel or scoop code.
 *
 * Cone and scoop are roles over one `WorkUnit`. The root test is
 * `parentJid === null` (`isRootUnit`), capabilities come from the unit's
 * policy, and parent/child routing goes through `WorkUnitManager`. The
 * `isCone` field survives only as a derived presentation flag for the UI and
 * the follower wire, so a `.isCone` read anywhere else is a new branch on a
 * role — exactly what the RFC set out to remove.
 *
 * Like the other ratchets, the baseline (`iscone-baseline.json`) is a frozen
 * one-way list of per-file read counts: pre-existing reads are grandfathered,
 * new ones (or a count above the baseline) fail, and fixed ones must be
 * removed (`--update` regenerates it). `packages/webapp/src/ui/` is out of
 * scope — it renders the role and is allowed to read the flag.
 *
 * Usage:
 *   node packages/dev-tools/tools/check-iscone-ratchet.mjs
 *   node packages/dev-tools/tools/check-iscone-ratchet.mjs --update
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { argv } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const Filename = fileURLToPath(import.meta.url);
export const repoRoot = resolve(dirname(Filename), '..', '..', '..');
export const BASELINE_PATH = resolve(dirname(Filename), 'iscone-baseline.json');
const SRC_ROOT = resolve(repoRoot, 'packages/webapp/src');
/** Presentation layer: may read the derived flag. */
const EXEMPT_PREFIXES = ['ui/'];
const READ_RE = /\.isCone\b/g;

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) yield full;
  }
}

/** Count `.isCone` reads per repo-relative file (non-test, non-ui). */
export function countReads() {
  const counts = {};
  for (const file of walk(SRC_ROOT)) {
    const rel = relative(SRC_ROOT, file).split('\\').join('/');
    if (EXEMPT_PREFIXES.some((p) => rel.startsWith(p))) continue;
    const n = (readFileSync(file, 'utf8').match(READ_RE) ?? []).length;
    if (n > 0) counts[`packages/webapp/src/${rel}`] = n;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function main() {
  const current = countReads();
  if (argv.includes('--update')) {
    writeFileSync(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`);
    console.log(`check-iscone-ratchet: baseline updated (${Object.keys(current).length} files)`);
    return;
  }
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  const problems = [];
  for (const [file, n] of Object.entries(current)) {
    const allowed = baseline[file] ?? 0;
    if (n > allowed) {
      problems.push(
        `${file}: ${n} \`.isCone\` read(s), baseline allows ${allowed}. Branch on the unit's ` +
          'policy / `isRootUnit(scoop)` / `orchestrator.getWorkUnits()` instead (docs/work-unit.md).'
      );
    }
  }
  for (const [file, allowed] of Object.entries(baseline)) {
    const n = current[file] ?? 0;
    if (n < allowed) {
      problems.push(
        `${file}: ${n} read(s) but baseline still lists ${allowed} — you paid debt down! ` +
          'Ratchet the baseline: node packages/dev-tools/tools/check-iscone-ratchet.mjs --update'
      );
    }
  }
  if (problems.length > 0) {
    console.error('check-iscone-ratchet: FAIL');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  const total = Object.values(current).reduce((a, b) => a + b, 0);
  console.log(
    `ok: no new \`.isCone\` reads outside packages/webapp/src/ui (${total} grandfathered in ${Object.keys(current).length} files)`
  );
}

if (import.meta.url === pathToFileURL(argv[1]).href) main();
