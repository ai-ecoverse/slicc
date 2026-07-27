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
import { pathToFileURL } from 'node:url';
import { readThresholds, repoRoot } from './coverage-ratchet-lib.mjs';

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
  // Packages with a bespoke exclude set (e.g. chrome-extension, which must
  // drop the webapp subtrees it transitively imports) override the config's
  // base excludes wholesale, matching the previous inline-script behavior.
  if (Array.isArray(floors.coverageExclude)) {
    for (const pattern of floors.coverageExclude) {
      args.push(`--coverage.exclude=${pattern}`);
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
  return result.status ?? 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main(process.argv.slice(2)));
}
