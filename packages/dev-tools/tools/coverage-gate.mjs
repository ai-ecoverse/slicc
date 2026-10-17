#!/usr/bin/env node
// CI coverage gate for a single TypeScript vitest project. Reads the
// package's floors from the repo-root coverage-thresholds.json and runs
// `vitest run --project <name> --coverage` with those thresholds, so the
// numbers live in exactly one machine-editable place (maintained by the
// nightly coverage ratchet) instead of being duplicated across npm scripts.
//
// Usage: node packages/dev-tools/tools/coverage-gate.mjs <package> [vitest args...]
//
// Anything after <package> is forwarded verbatim to vitest, so a caller can
// add run-wide options (`--reporter=json`, `--outputFile=...`, `--bail`) without
// paying for a second full run of the same suite.

import { spawnSync } from 'node:child_process';
import { readThresholds, repoRoot } from './coverage-ratchet-lib.mjs';
import { isMainModule } from './is-main-module.mjs';

const METRICS = ['lines', 'statements', 'functions', 'branches'];

/**
 * @param {string} pkg vitest project name
 * @param {Record<string, unknown>} floors entry from coverage-thresholds.json
 * @param {string[]} [extraArgs] forwarded verbatim, after the threshold flags
 * @returns {string[]} argv for `vitest`
 */
export function buildVitestArgs(pkg, floors, extraArgs = []) {
  const args = ['run', '--project', pkg, '--coverage'];
  for (const metric of METRICS) {
    if (typeof floors[metric] === 'number') {
      args.push(`--coverage.thresholds.${metric}=${floors[metric]}`);
    }
  }
  // Packages with a bespoke exclude set (e.g. cloud-core, which must drop
  // the sibling-package source it transitively imports) override the
  // config's base excludes wholesale, matching the previous inline-script
  // behavior. Those packages have their own coverage gates.
  if (Array.isArray(floors.coverageExclude)) {
    for (const pattern of floors.coverageExclude) {
      args.push(`--coverage.exclude=${pattern}`);
    }
  }
  // An explicit include list makes files the suite never imported count as
  // 0% instead of vanishing from the report — vitest only reports loaded
  // files by default, so a package of standalone scripts (github-workflow)
  // would otherwise look fully covered as soon as one script had a test.
  if (Array.isArray(floors.coverageInclude)) {
    for (const pattern of floors.coverageInclude) {
      args.push(`--coverage.include=${pattern}`);
    }
  }
  return [...args, ...extraArgs];
}

function main(argv) {
  const [pkg, ...extraArgs] = argv;
  if (!pkg) {
    console.error('usage: coverage-gate.mjs <package> [vitest args...]');
    return 2;
  }

  const floors = readThresholds().typescript?.[pkg];
  if (!floors) {
    console.error(`No TypeScript coverage floors for "${pkg}" in coverage-thresholds.json`);
    return 2;
  }

  const result = spawnSync('npx', ['vitest', ...buildVitestArgs(pkg, floors, extraArgs)], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
  });
  const status = result.status ?? 1;
  // The verdict line that require-verdict.mjs checks for; see its header.
  console.log(
    status === 0
      ? `coverage-gate: PASS ${pkg}`
      : `coverage-gate: FAIL ${pkg} (vitest exit ${status})`
  );
  return status;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  process.exit(main(process.argv.slice(2)));
}
