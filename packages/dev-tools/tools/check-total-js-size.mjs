#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { measureMergeBase, resolveBaselineRef } from './first-load-baseline.mjs';
import { checkTotalJsDelta, measureTotalJs } from './total-js-size-lib.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const args = process.argv.slice(2);
const jsonOnly = args.includes('--json');
const isMergeGroup = process.env.GITHUB_EVENT_NAME === 'merge_group';
const isCiPullRequest = process.env.GITHUB_EVENT_NAME === 'pull_request';
const fail = (message) => {
  console.error(`check-total-js-size: ${message}`);
  process.exit(1);
};

let head;
try {
  head = measureTotalJs(resolve(repoRoot, 'dist/ui'));
} catch (error) {
  fail(error.message);
}
if (jsonOnly) {
  console.log(JSON.stringify(head));
  process.exit(0);
}

let baselineRef;
try {
  baselineRef = resolveBaselineRef({ args, env: process.env });
} catch (error) {
  fail(error.message);
}
const { maxDeltaKb } = JSON.parse(
  readFileSync(resolve(repoRoot, 'packages/webapp/total-js-budget.json'), 'utf8')
);
let baseline = null;
if (baselineRef !== 'none' && !isMergeGroup) {
  console.log(`Measuring the merge-base with ${baselineRef} for total JS comparison…`);
  baseline = measureMergeBase({
    repoRoot,
    ref: baselineRef,
    measure: measureTotalJs,
    log: (message) => console.log(`  baseline: ${message}`),
  });
}
if (!isMergeGroup && baselineRef !== 'none' && !baseline && isCiPullRequest) {
  fail(
    `could not measure the merge-base with "${baselineRef}"; the per-change total JS delta must be checked before queueing`
  );
}

let result;
try {
  result = checkTotalJsDelta(head, baseline?.bytes ?? null, maxDeltaKb);
} catch (error) {
  fail(error.message);
}
const sizeKb = (head.bytes / 1024).toFixed(1);
console.log(`Webapp total JS: ${head.bytes} B (${sizeKb} KiB) across ${head.files} files.`);
if (result.deltaKb === null) {
  console.log(
    isMergeGroup
      ? '  merge_group: per-change delta was checked on each PR; size-limit enforces the absolute cap here.'
      : '  baseline unavailable or disabled: size-limit still enforces the absolute cap.'
  );
} else {
  console.log(
    `  ${result.deltaKb >= 0 ? '+' : ''}${result.deltaKb.toFixed(1)} KiB vs merge-base; allowance ${maxDeltaKb} KiB.`
  );
}
if (!result.passed) {
  fail(
    `this change grows total JS by ${result.deltaKb.toFixed(1)} KiB, over the ${maxDeltaKb} KiB allowance; investigate emitted chunks or justify a budget change in the PR`
  );
}
