#!/usr/bin/env node
// Coverage / budget ratchet. Measures the current state of every gated budget
// and moves it toward reality: coverage floors in coverage-thresholds.json go
// *up* (never down), while the ceilings — duplication in jscpd.json, the
// `size-limit` budgets in packages/*/package.json and the per-test duration
// ceilings in coverage-thresholds.json `testTiming` — come *down* (never up).
// Both directions keep a safety margin so ordinary jitter cannot flip a gate
// red on the next run (see nextFloor / nextCeiling in coverage-ratchet-lib.mjs).
// Intended to run nightly; a workflow then opens a PR when something changed.
//
// Usage:
//   node packages/dev-tools/tools/coverage-ratchet.mjs [options]
//     --ts-only            only measure TypeScript coverage
//     --swift-only         only measure Swift coverage
//     --go-only            only measure Go coverage
//     --duplication-only   only measure the jscpd duplication ceiling
//     --bundle-only        only measure the size-limit ceilings
//     --timing-only        only measure the per-test duration ceilings
//     --only=<pkg>         restrict TypeScript/Swift/timing to one package
//     --no-write           print proposed changes without editing any file
//     --github-output      append `changed=<bool>` to $GITHUB_OUTPUT

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  nextDuplicationThreshold,
  parseJscpdPercentage,
  parseSizeLimitJson,
  ratchetSizeLimits,
  ratchetTiming,
  readJscpdConfig,
  readPackageJson,
  SIZE_LIMIT_PACKAGES,
  summarizeTiming,
  TIMED_PROJECTS,
  writeJscpdThreshold,
  writeSizeLimits,
} from './ceiling-ratchet-lib.mjs';
import {
  applyRatchet,
  parseVitestSummary,
  readThresholds,
  repoRoot,
  SWIFT_METRICS,
  writeThresholds,
} from './coverage-ratchet-lib.mjs';

const argv = process.argv.slice(2);
const flags = new Set(argv);
const write = !flags.has('--no-write');
const MEASUREMENTS = ['ts', 'swift', 'go', 'duplication', 'bundle', 'timing'];
const exclusive = MEASUREMENTS.filter((name) => flags.has(`--${name}-only`));
const enabled = (name) => exclusive.length === 0 || exclusive.includes(name);
// `--only=<pkg>` restricts measurement to a single package (useful for
// verifying one package's coverage path without re-measuring the whole repo).
const onlyArg = argv.find((a) => a.startsWith('--only='));
const only = onlyArg ? onlyArg.slice('--only='.length) : null;

const SWIFT_BUNDLES = {
  'swift-server': 'SliccServerPackageTests',
  'swift-optel': 'SwiftOptelPackageTests',
  'swift-launcher': 'SliccstartPackageTests',
  // ios-app cannot run `swift test` at all (iOS-only WebRTC dependency), so it
  // is measured through the coverage script's --xcodebuild simulator mode. The
  // "bundle" there is the app target carrying the code under test.
  'ios-app': { bundle: 'SliccFollower', xcodebuildScheme: 'SliccFollower' },
};

// Packages whose coverage is produced by a dedicated vitest config (e.g.
// browser-mode packages) rather than a root `--project`. Measured with that
// config so the ratchet numbers match the CI gate (npm run test:coverage:<pkg>).
const TS_CONFIG_OVERRIDES = {
  webcomponents: 'packages/webcomponents/vitest.config.ts',
};

const timingMeasured = {};

function readTiming(file, project) {
  if (!existsSync(file)) {
    console.error(`  [skip] ${project} timing: no vitest json report`);
    return;
  }
  const summary = summarizeTiming(JSON.parse(readFileSync(file, 'utf-8')), TIMED_PROJECTS[project]);
  if (!summary) {
    console.error(`  [skip] ${project} timing: no per-test durations in the report`);
    return;
  }
  timingMeasured[project] = summary;
}

function measureTs(pkg, floors) {
  const out = mkdtempSync(join(tmpdir(), `cov-${pkg}-`));
  const configPath = TS_CONFIG_OVERRIDES[pkg];
  const selector = configPath ? ['--config', configPath] : ['--project', pkg];
  const args = [
    'vitest',
    'run',
    ...selector,
    '--coverage',
    '--coverage.reporter=json-summary',
    `--coverage.reportsDirectory=${out}`,
  ];
  if (Array.isArray(floors.coverageExclude)) {
    for (const pattern of floors.coverageExclude) args.push(`--coverage.exclude=${pattern}`);
  }
  // The timed projects get their per-test durations out of this same run, so
  // the timing ceilings cost no extra suite execution.
  const timingFile = TIMED_PROJECTS[pkg] ? join(out, 'timing.json') : null;
  if (timingFile) {
    args.push('--reporter=default', '--reporter=json', `--outputFile=${timingFile}`);
  }
  const res = spawnSync('npx', args, { cwd: repoRoot, stdio: 'inherit', env: process.env });
  if (timingFile && enabled('timing')) readTiming(timingFile, pkg);
  const summaryFile = join(out, 'coverage-summary.json');
  if (!existsSync(summaryFile)) {
    console.error(`  [skip] ${pkg}: no coverage-summary.json (exit ${res.status})`);
    return null;
  }
  return parseVitestSummary(JSON.parse(readFileSync(summaryFile, 'utf-8')));
}

function measureSwift(pkg) {
  const entry = SWIFT_BUNDLES[pkg];
  if (!entry) {
    console.error(`  [skip] ${pkg}: unknown Swift test bundle`);
    return null;
  }
  const { bundle, xcodebuildScheme } = typeof entry === 'string' ? { bundle: entry } : entry;
  const mode = xcodebuildScheme ? ['--xcodebuild', xcodebuildScheme] : [];
  const script = resolve(repoRoot, 'packages/dev-tools/tools/swift-coverage-check.sh');
  // Pass `0 0 0` floors so measurement never fails here; the JSON summary is
  // written regardless and the real gate still runs in CI.
  spawnSync(script, [...mode, `packages/${pkg}`, bundle, '0', '0', '0'], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
  });
  const summaryFile = resolve(repoRoot, `packages/${pkg}/.build/coverage/summary.json`);
  if (!existsSync(summaryFile)) {
    console.error(`  [skip] ${pkg}: no swift summary.json`);
    return null;
  }
  const raw = JSON.parse(readFileSync(summaryFile, 'utf-8'));
  const measured = {};
  for (const metric of SWIFT_METRICS) {
    if (typeof raw[metric] === 'number') measured[metric] = raw[metric];
  }
  return measured;
}

// Go total-statement coverage, via the same `make cover` path CI gates with.
// COVER_MIN=0 so measurement never fails here; the real floor still gates in CI.
function measureGo(pkg) {
  const res = spawnSync('make', ['cover', 'COVER_MIN=0'], {
    cwd: resolve(repoRoot, `packages/${pkg}`),
    encoding: 'utf-8',
    env: process.env,
  });
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  const match = /total coverage:\s*([\d.]+)%/.exec(output);
  if (!match) {
    console.error(`  [skip] ${pkg}: make cover produced no total (exit ${res.status})`);
    return null;
  }
  return { statements: Number(match[1]) };
}

function measureDuplication() {
  const out = mkdtempSync(join(tmpdir(), 'jscpd-ratchet-'));
  // --threshold 100 so jscpd reports instead of failing on the current budget.
  const res = spawnSync(
    'npx',
    [
      'jscpd',
      '--config',
      'jscpd.json',
      '--no-tips',
      '--threshold',
      '100',
      '--reporters',
      'json,silent',
      '--output',
      out,
    ],
    { cwd: repoRoot, stdio: 'inherit', env: process.env }
  );
  const reportFile = join(out, 'jscpd-report.json');
  if (!existsSync(reportFile)) {
    console.error(`  [skip] duplication: no jscpd-report.json (exit ${res.status})`);
    return null;
  }
  const pct = parseJscpdPercentage(JSON.parse(readFileSync(reportFile, 'utf-8')));
  if (pct === null) console.error('  [skip] duplication: report carries no total percentage');
  return pct;
}

// size-limit measures the built artifacts, so a stale or missing dist/ would
// hand the ratchet a wrong number. It exits non-zero and prints nothing usable
// when a configured path matches no file, which is the skip signal here.
function measureBundleSizes(pkgDir) {
  const res = spawnSync('npx', ['size-limit', '--json'], {
    cwd: resolve(repoRoot, pkgDir),
    encoding: 'utf-8',
    env: process.env,
  });
  let report;
  try {
    report = JSON.parse(res.stdout ?? '');
  } catch {
    console.error(`  [skip] ${pkgDir}: size-limit produced no JSON (exit ${res.status}) — built?`);
    if (res.stderr) console.error(res.stderr.trim());
    return null;
  }
  const sizes = parseSizeLimitJson(report);
  if (Object.keys(sizes).length === 0) {
    console.error(`  [skip] ${pkgDir}: size-limit reported no budgets`);
    return null;
  }
  return sizes;
}

// Timing-only mode still needs the suite to run, but not with coverage.
function measureTimingStandalone(project) {
  const out = mkdtempSync(join(tmpdir(), `timing-${project}-`));
  const timingFile = join(out, 'timing.json');
  spawnSync(
    'npx',
    [
      'vitest',
      'run',
      '--project',
      project,
      '--reporter=default',
      '--reporter=json',
      `--outputFile=${timingFile}`,
    ],
    { cwd: repoRoot, stdio: 'inherit', env: process.env }
  );
  readTiming(timingFile, project);
}

const thresholds = readThresholds();
const measured = { typescript: {}, swift: {}, go: {} };

if (enabled('ts')) {
  for (const pkg of Object.keys(thresholds.typescript ?? {})) {
    if (only && pkg !== only) continue;
    console.error(`==> measuring TypeScript: ${pkg}`);
    const m = measureTs(pkg, thresholds.typescript[pkg]);
    if (m) measured.typescript[pkg] = m;
  }
}
if (enabled('swift')) {
  for (const pkg of Object.keys(thresholds.swift ?? {})) {
    if (only && pkg !== only) continue;
    console.error(`==> measuring Swift: ${pkg}`);
    const m = measureSwift(pkg);
    if (m) measured.swift[pkg] = m;
  }
}
if (enabled('go')) {
  for (const pkg of Object.keys(thresholds.go ?? {})) {
    if (only && pkg !== only) continue;
    console.error(`==> measuring Go: ${pkg}`);
    const m = measureGo(pkg);
    if (m) measured.go[pkg] = m;
  }
}
if (enabled('timing') && !enabled('ts')) {
  for (const project of Object.keys(TIMED_PROJECTS)) {
    if (only && project !== only) continue;
    console.error(`==> measuring test timing: ${project}`);
    measureTimingStandalone(project);
  }
}

const { thresholds: next, changes } = applyRatchet(thresholds, measured);

const timingChanges = [];
if (enabled('timing')) {
  const { ceilings, changes: tChanges } = ratchetTiming(next.testTiming, timingMeasured);
  if (tChanges.length > 0) next.testTiming = ceilings;
  timingChanges.push(...tChanges);
}

let duplicationChange = null;
if (enabled('duplication')) {
  console.error('==> measuring duplication');
  const pct = measureDuplication();
  if (pct !== null) {
    duplicationChange = nextDuplicationThreshold(readJscpdConfig().threshold, pct);
  }
}

const bundleUpdates = [];
if (enabled('bundle')) {
  for (const pkgDir of SIZE_LIMIT_PACKAGES) {
    console.error(`==> measuring bundle size: ${pkgDir}`);
    const sizes = measureBundleSizes(pkgDir);
    if (!sizes) continue;
    const sizeChanges = ratchetSizeLimits(readPackageJson(pkgDir), sizes);
    if (sizeChanges.length > 0) bundleUpdates.push({ pkgDir, changes: sizeChanges });
  }
}

const bundleChanges = bundleUpdates.flatMap((u) =>
  u.changes.map((c) => ({ pkgDir: u.pkgDir, ...c }))
);
const changed =
  changes.length > 0 ||
  timingChanges.length > 0 ||
  bundleChanges.length > 0 ||
  duplicationChange !== null;

console.log('\n=== Coverage ratchet ===');
if (changes.length === 0) {
  console.log('No floors raised.');
} else {
  for (const c of changes) {
    console.log(
      `  ${c.group}/${c.package} ${c.metric}: ${c.from} -> ${c.to} (measured ${c.actual}%)`
    );
  }
}

console.log('\n=== Ceiling ratchet ===');
if (duplicationChange) {
  console.log(
    `  duplication threshold: ${duplicationChange.from} -> ${duplicationChange.to} (measured ${duplicationChange.actual.toFixed(2)}%)`
  );
}
for (const c of bundleChanges) {
  console.log(
    `  ${c.name}: ${c.from} ${c.unit} -> ${c.to} ${c.unit} (measured ${c.actualBytes} B)`
  );
}
for (const project of Object.keys(timingMeasured)) {
  const m = timingMeasured[project];
  console.log(
    `  [measured] ${project} timing: p95 ${m.p95Ms}ms, slowest ${m.slowestMs}ms over ${m.tests} tests (${m.retried} retried, excluded)`
  );
}
for (const c of timingChanges) {
  console.log(
    `  ${c.project} ${c.metric}: ${c.from ?? '(unset)'} -> ${c.to} (measured p95 ${c.actual}ms)`
  );
}
if (!changed) console.log('  No ceilings tightened.');

if (changed && write) {
  if (changes.length > 0 || timingChanges.length > 0) {
    writeThresholds(next);
    console.log('coverage-thresholds.json updated.');
  }
  if (duplicationChange) {
    const ok = writeJscpdThreshold(duplicationChange.to);
    console.log(ok ? 'jscpd.json updated.' : '  [skip] jscpd.json: no threshold to patch');
  }
  for (const update of bundleUpdates) {
    const ok = writeSizeLimits(update.pkgDir, update.changes);
    console.log(
      ok
        ? `${update.pkgDir}/package.json updated.`
        : `  [skip] ${update.pkgDir}: size-limit block not patchable`
    );
  }
} else if (changed) {
  console.log('(--no-write: no file modified)');
}

if (flags.has('--github-output') && process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
}
