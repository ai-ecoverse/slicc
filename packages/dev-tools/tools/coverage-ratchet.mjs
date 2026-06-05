#!/usr/bin/env node
// Coverage ratchet. Measures current coverage for every gated package and
// raises the floors in coverage-thresholds.json toward reality (never
// lowering, keeping <1% headroom). Intended to run nightly; a workflow then
// opens a PR when the file changed. Each ratchet step is a clean >=1pp bump,
// so there is never a sub-1pp change to review.
//
// Usage:
//   node packages/dev-tools/tools/coverage-ratchet.mjs [options]
//     --ts-only        only measure TypeScript packages
//     --swift-only     only measure Swift packages
//     --no-write       print proposed changes without editing the file
//     --github-output  append `changed=<bool>` to $GITHUB_OUTPUT

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  applyRatchet,
  parseVitestSummary,
  readThresholds,
  repoRoot,
  SWIFT_METRICS,
  writeThresholds,
} from './coverage-ratchet-lib.mjs';

const flags = new Set(process.argv.slice(2));
const doTs = !flags.has('--swift-only');
const doSwift = !flags.has('--ts-only');
const write = !flags.has('--no-write');

const SWIFT_BUNDLES = {
  'swift-server': 'SliccServerPackageTests',
  'swift-launcher': 'SliccstartPackageTests',
};

function measureTs(pkg, floors) {
  const out = mkdtempSync(join(tmpdir(), `cov-${pkg}-`));
  const args = [
    'vitest',
    'run',
    '--project',
    pkg,
    '--coverage',
    '--coverage.reporter=json-summary',
    `--coverage.reportsDirectory=${out}`,
  ];
  if (Array.isArray(floors.coverageExclude)) {
    for (const pattern of floors.coverageExclude) args.push(`--coverage.exclude=${pattern}`);
  }
  const res = spawnSync('npx', args, { cwd: repoRoot, stdio: 'inherit', env: process.env });
  const summaryFile = join(out, 'coverage-summary.json');
  if (!existsSync(summaryFile)) {
    console.error(`  [skip] ${pkg}: no coverage-summary.json (exit ${res.status})`);
    return null;
  }
  return parseVitestSummary(JSON.parse(readFileSync(summaryFile, 'utf-8')));
}

function measureSwift(pkg) {
  const bundle = SWIFT_BUNDLES[pkg];
  if (!bundle) {
    console.error(`  [skip] ${pkg}: unknown Swift test bundle`);
    return null;
  }
  const script = resolve(repoRoot, 'packages/dev-tools/tools/swift-coverage-check.sh');
  // Pass `0 0 0` floors so measurement never fails here; the JSON summary is
  // written regardless and the real gate still runs in CI.
  spawnSync(script, [`packages/${pkg}`, bundle, '0', '0', '0'], {
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

const thresholds = readThresholds();
const measured = { typescript: {}, swift: {} };

if (doTs) {
  for (const pkg of Object.keys(thresholds.typescript ?? {})) {
    console.error(`==> measuring TypeScript: ${pkg}`);
    const m = measureTs(pkg, thresholds.typescript[pkg]);
    if (m) measured.typescript[pkg] = m;
  }
}
if (doSwift) {
  for (const pkg of Object.keys(thresholds.swift ?? {})) {
    console.error(`==> measuring Swift: ${pkg}`);
    const m = measureSwift(pkg);
    if (m) measured.swift[pkg] = m;
  }
}

const { thresholds: next, changes } = applyRatchet(thresholds, measured);

console.log('\n=== Coverage ratchet ===');
if (changes.length === 0) {
  console.log('No floors raised; coverage-thresholds.json unchanged.');
} else {
  for (const c of changes) {
    console.log(
      `  ${c.group}/${c.package} ${c.metric}: ${c.from} -> ${c.to} (measured ${c.actual}%)`
    );
  }
  if (write) {
    writeThresholds(next);
    console.log('coverage-thresholds.json updated.');
  } else {
    console.log('(--no-write: file not modified)');
  }
}

if (flags.has('--github-output') && process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changes.length > 0}\n`);
}
