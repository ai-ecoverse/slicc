#!/usr/bin/env node
// CI coverage gate for a single TypeScript vitest project. Reads the
// package's floors from the repo-root coverage-thresholds.json and runs
// `vitest run --project <name> --coverage` with those thresholds, so the
// numbers live in exactly one machine-editable place (maintained by the
// nightly coverage ratchet) instead of being duplicated across npm scripts.
//
// Usage: node packages/dev-tools/tools/coverage-gate.mjs <package>

import { spawnSync } from 'node:child_process';
import { readThresholds, repoRoot } from './coverage-ratchet-lib.mjs';

const pkg = process.argv[2];
if (!pkg) {
  console.error('usage: coverage-gate.mjs <package>');
  process.exit(2);
}

const thresholds = readThresholds();
const floors = thresholds.typescript?.[pkg];
if (!floors) {
  console.error(`No TypeScript coverage floors for "${pkg}" in coverage-thresholds.json`);
  process.exit(2);
}

const args = ['run', '--project', pkg, '--coverage'];
for (const metric of ['lines', 'statements', 'functions', 'branches']) {
  if (typeof floors[metric] === 'number') {
    args.push(`--coverage.thresholds.${metric}=${floors[metric]}`);
  }
}
// Packages with a bespoke exclude set (e.g. chrome-extension, which must
// drop the webapp subtrees it transitively imports) override the config's
// base excludes wholesale, matching the previous inline-script behavior.
if (Array.isArray(floors.coverageExclude)) {
  for (const pattern of floors.coverageExclude) {
    args.push(`--coverage.exclude=${pattern}`);
  }
}

const result = spawnSync('npx', ['vitest', ...args], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: process.env,
});

process.exit(result.status ?? 1);
