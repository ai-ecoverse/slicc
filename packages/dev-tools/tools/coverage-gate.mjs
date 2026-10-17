#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readThresholds, repoRoot } from './coverage-ratchet-lib.mjs';
import { isMainModule } from './is-main-module.mjs';

const METRICS = ['lines', 'statements', 'functions', 'branches'];

export function buildVitestArgs(pkg, floors, extraArgs = []) {
  const args = ['run', '--project', pkg, '--coverage'];
  for (const metric of METRICS) {
    if (typeof floors[metric] === 'number') {
      args.push(`--coverage.thresholds.${metric}=${floors[metric]}`);
    }
  }

  if (Array.isArray(floors.coverageExclude)) {
    for (const pattern of floors.coverageExclude) {
      args.push(`--coverage.exclude=${pattern}`);
    }
  }

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
