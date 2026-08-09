#!/usr/bin/env node
/**
 * `Record<string, unknown>` ratchet: no NEW untyped string-keyed bag in source.
 *
 * `Record<string, unknown>` is what a type looks like when nobody decided what
 * the shape is. It type-checks, so it never shows up as an error, and it
 * spreads: every consumer of a bag has to re-narrow it, and the narrowing is
 * ad-hoc and unverified. The repo had accumulated 604 of them across 181
 * source files before this gate existed.
 *
 * Detection is a Biome analyzer plugin (`.biome-plugins/no-record-string-unknown.grit`)
 * rather than a regex, so it matches the real type node — line-wrapped
 * occurrences count, `Record<string, string>` does not, and a
 * `// biome-ignore lint/plugin: <reason>` comment suppresses a line the same
 * way it would any other Biome diagnostic.
 *
 * The plugin cannot live in the root `biome.json`: at `severity = "error"` it
 * would fail `lint:ci` on all 604 pre-existing occurrences, and Biome's
 * `--skip=plugin` / `overrides[].plugins` are group-level, so there is no way
 * to exempt files per-plugin. Instead `biome.record-gate.json` extends the root
 * config (inheriting `files.includes` verbatim — zero drift) and swaps in this
 * one plugin; this script runs it and enforces the baseline.
 *
 * Like check-layer-back-edges.mjs, the baseline
 * (record-string-unknown-baseline.json) is a frozen one-way ratchet:
 * pre-existing occurrences are grandfathered per file, new ones fail, and
 * fixed ones must be removed (`--update` regenerates it). Test files are out
 * of scope — `(globalThis as Record<string, unknown>).chrome = …` is idiomatic
 * scaffolding with no better spelling, and biome.json already exempts tests
 * from noExplicitAny and the complexity rules for the same reason.
 *
 * Usage:
 *   node packages/dev-tools/tools/check-record-string-unknown.mjs
 *   node packages/dev-tools/tools/check-record-string-unknown.mjs --update
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { argv } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const Filename = fileURLToPath(import.meta.url);
export const repoRoot = resolve(dirname(Filename), '..', '..', '..');

export const BASELINE_PATH = resolve(dirname(Filename), 'record-string-unknown-baseline.json');

/** Repo-root-relative path of the plugin-only Biome config this gate drives. */
export const GATE_CONFIG_REL = 'biome.record-gate.json';

/** Repo-root-relative path of the GritQL plugin that does the detecting. */
export const PLUGIN_REL = '.biome-plugins/no-record-string-unknown.grit';

/**
 * Substring identifying this rule's diagnostics. The gate config swaps the
 * root config's plugin list for ours alone, but filtering on the message keeps
 * the scan precise if a second plugin is ever added there.
 */
const DIAGNOSTIC_MARKER = 'Record<string, unknown> is banned';

/** Biome's own node shim — spawned via process.execPath so Windows works too. */
const BIOME_BIN = resolve(repoRoot, 'node_modules/@biomejs/biome/bin/biome');

/**
 * Tests are out of scope. Mirrors the test globs biome.json already uses for
 * its own per-rule test exemptions (`**​/*.test.ts`, `**​/test-*.mjs`) plus the
 * repo's `packages/*​/tests/` convention.
 */
export function isTestPath(relPath) {
  return (
    /(^|\/)tests?\//.test(relPath) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(relPath) ||
    /(^|\/)test-[^/]*\.[cm]?js$/.test(relPath)
  );
}

/**
 * Extract this rule's hits from a parsed Biome `--reporter=json` payload.
 * Returns `[{ file, line, column }]`, test files excluded, sorted by
 * file then line. Pure — the unit tests drive it without spawning Biome.
 */
export function parseDiagnostics(payload) {
  const diagnostics = payload?.diagnostics;
  if (!Array.isArray(diagnostics)) return [];
  const hits = [];
  for (const d of diagnostics) {
    if (typeof d?.message !== 'string' || !d.message.includes(DIAGNOSTIC_MARKER)) continue;
    const raw = d.location?.path;
    if (typeof raw !== 'string' || raw.length === 0) continue;
    const file = raw.split('\\').join('/');
    if (isTestPath(file)) continue;
    hits.push({ file, line: d.location?.start?.line ?? 0, column: d.location?.start?.column ?? 0 });
  }
  return hits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/** Collapse hits into `{ 'packages/…/file.ts': count }`. */
export function countsFromHits(hits) {
  const counts = {};
  for (const h of hits) counts[h.file] = (counts[h.file] ?? 0) + 1;
  return counts;
}

/**
 * Run Biome with the plugin-only gate config over the whole repo.
 * Returns `{ counts, hits }`. Throws if Biome could not be run or produced
 * output we cannot parse — an infra failure must not read as "tree is clean".
 */
export function scanRecordTypes() {
  for (const [label, rel] of [
    ['gate config', GATE_CONFIG_REL],
    ['GritQL plugin', PLUGIN_REL],
  ]) {
    if (!existsSync(resolve(repoRoot, rel))) throw new Error(`missing ${label}: ${rel}`);
  }
  if (!existsSync(BIOME_BIN)) {
    throw new Error(
      `biome not installed at ${relative(repoRoot, BIOME_BIN)} — run \`npm install\``
    );
  }

  const r = spawnSync(
    process.execPath,
    [
      BIOME_BIN,
      'lint',
      `--config-path=${GATE_CONFIG_REL}`,
      '--only=plugin',
      '--reporter=json',
      '.',
    ],
    { cwd: repoRoot, encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024 }
  );

  // Biome exits 1 when it emits diagnostics, which is the expected path here;
  // only treat unparseable stdout as a failure.
  if (r.error) throw new Error(`failed to run biome: ${r.error.message}`);
  let payload;
  try {
    payload = JSON.parse(r.stdout);
  } catch {
    const detail = (r.stderr || '').trim() || (r.stdout || '').slice(0, 400);
    throw new Error(`biome did not emit parseable JSON (exit ${r.status}): ${detail}`);
  }

  const hits = parseDiagnostics(payload);
  return { counts: countsFromHits(hits), hits };
}

// The boy-scout gate (check-touched-exemptions.mjs) reads this baseline as a
// debt list via the generic `baselineFiles` helper exported by
// check-layer-back-edges.mjs — both baselines share the `{ file: count }` shape.

const UPDATE_HINT = 'node packages/dev-tools/tools/check-record-string-unknown.mjs --update';

/**
 * Compare `current` counts against `baseline`. Returns failure messages —
 * empty when the tree matches the ratchet. Counts may only go down, and a
 * reduction must be banked in the baseline in the same PR.
 */
export function compareToBaseline(current, baseline) {
  const failures = [];
  for (const [file, count] of Object.entries(current)) {
    const allowed = baseline[file] ?? 0;
    if (count > allowed) {
      failures.push(
        `${file}: ${count} Record<string, unknown>, baseline allows ${allowed} — declare a ` +
          'named type for the shape instead of adding another untyped bag.'
      );
    } else if (count < allowed) {
      failures.push(
        `${file}: ${count} Record<string, unknown>, baseline says ${allowed} — thanks for ` +
          `paying debt down! Ratchet the baseline: ${UPDATE_HINT}`
      );
    }
  }
  for (const file of Object.keys(baseline)) {
    if (!(file in current)) {
      failures.push(`${file}: baseline entry is stale (file clean or gone) — run ${UPDATE_HINT}`);
    }
  }
  return failures;
}

function sortedCounts(counts) {
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function total(counts) {
  return Object.values(counts).reduce((a, b) => a + b, 0);
}

function main() {
  let scan;
  try {
    scan = scanRecordTypes();
  } catch (err) {
    process.stderr.write(`::error::check-record-string-unknown: ${err.message}\n`);
    return 2;
  }
  const { counts, hits } = scan;

  if (argv.includes('--update')) {
    writeFileSync(BASELINE_PATH, `${JSON.stringify(sortedCounts(counts), null, 2)}\n`);
    process.stdout.write(
      `baseline updated: ${total(counts)} grandfathered Record<string, unknown> in ` +
        `${Object.keys(counts).length} source file(s)\n`
    );
    return 0;
  }

  let baseline;
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  } catch (err) {
    process.stderr.write(
      `::error::check-record-string-unknown: cannot read baseline ` +
        `${relative(repoRoot, BASELINE_PATH)}: ${err.message}\n`
    );
    return 2;
  }

  const failures = compareToBaseline(counts, baseline);
  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`::error::${failure}\n`);
    for (const h of hits) {
      if (counts[h.file] <= (baseline[h.file] ?? 0)) continue;
      process.stderr.write(`  ${h.file}:${h.line}:${h.column} Record<string, unknown>\n`);
    }
    process.stderr.write(
      `\n${failures.length} Record<string, unknown> violation(s). Name the shape you ` +
        'actually accept (see docs/review-patterns.md § Untyped string-keyed bags) rather ' +
        'than growing the baseline. For a genuinely untyped payload, suppress the line with ' +
        '`// biome-ignore lint/plugin: <reason>`.\n'
    );
    return 1;
  }

  process.stdout.write(
    `ok: no new Record<string, unknown> in source (${total(counts)} grandfathered in ` +
      `${Object.keys(counts).length} baselined files)\n`
  );
  return 0;
}

if (import.meta.url === pathToFileURL(argv[1] ?? '').href) process.exit(main());
