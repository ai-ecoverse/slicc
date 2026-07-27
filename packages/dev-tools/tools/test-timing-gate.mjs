#!/usr/bin/env node
// Slow-test gate. Compares the p95 per-test duration of one vitest project
// against its ceiling in coverage-thresholds.json (`testTiming`), which the
// nightly ratchet tightens toward reality. The timing report is produced for
// free by the json reporter that already runs in CI (vitest.config.ts), so
// this costs no extra suite execution.
//
// p95 rather than the slowest test: it is an order statistic over hundreds of
// tests, so one slow sample on a loaded shared runner cannot move it, while a
// genuine distribution shift (the drift that took CI from 1.5-8 min to
// 7-12.4 min) does.
//
// Missing report, missing project entry or a report with no durations all
// *skip*: observability that fails closed on its own plumbing would be worse
// than the drift it watches.
//
// Usage: node packages/dev-tools/tools/test-timing-gate.mjs <project> [report.json]

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { evaluateTiming, summarizeTiming, TIMED_PROJECTS } from './ceiling-ratchet-lib.mjs';
import { readThresholds, repoRoot } from './coverage-ratchet-lib.mjs';

const DEFAULT_REPORT = 'test-timing/vitest.json';

function main(argv) {
  const [project, reportArg] = argv;
  if (!project) {
    console.error('usage: test-timing-gate.mjs <project> [report.json]');
    return 2;
  }
  const pathPrefix = TIMED_PROJECTS[project];
  if (!pathPrefix) {
    console.error(`test-timing-gate: "${project}" has no test-path prefix in TIMED_PROJECTS`);
    return 2;
  }
  const reportFile = resolve(repoRoot, reportArg ?? DEFAULT_REPORT);
  if (!existsSync(reportFile)) {
    console.log(`[skip] ${project} timing: no report at ${reportArg ?? DEFAULT_REPORT}`);
    return 0;
  }

  const ceiling = readThresholds().testTiming?.[project]?.p95Ms;
  const result = evaluateTiming(
    summarizeTiming(JSON.parse(readFileSync(reportFile, 'utf-8')), pathPrefix),
    ceiling
  );
  if (result.status === 'skip') {
    console.log(`[skip] ${project} timing: ${result.reason}`);
    return 0;
  }
  const { summary, ceilingMs } = result;
  const detail = `p95 ${summary.p95Ms}ms (ceiling ${ceilingMs}ms), slowest ${summary.slowestMs}ms over ${summary.tests} tests, ${summary.retried} retried sample(s) excluded`;
  if (result.status === 'fail') {
    console.error(`::error::${project} tests got slower: ${detail}`);
    console.error(`  slowest test: ${summary.slowestTest}`);
    return 1;
  }
  console.log(`${project} timing ok: ${detail}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main(process.argv.slice(2)));
}
