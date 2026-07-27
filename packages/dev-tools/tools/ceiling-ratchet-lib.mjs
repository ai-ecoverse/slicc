// Shared logic for the three *ceiling* budgets the nightly ratchet tightens:
// duplication (jscpd.json `threshold`), bundle size (`size-limit` blocks in
// packages/*/package.json) and per-test duration (coverage-thresholds.json
// `testTiming`). Floors live in coverage-ratchet-lib.mjs; the primitive both
// directions share is nextCeiling/nextFloor.
//
// Everything above the IO helpers at the bottom is pure and unit-tested by the
// `dev-tools` vitest project.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  BYTES_MARGIN_RATIO,
  DUPLICATION_GRANULARITY,
  DUPLICATION_MARGIN,
  nextCeiling,
  repoRoot,
  TIMING_GRANULARITY_MS,
  TIMING_MARGIN_RATIO,
} from './coverage-ratchet-lib.mjs';

export const jscpdConfigPath = resolve(repoRoot, 'jscpd.json');

// The packages carrying a `size-limit` block, in the order `npm run
// bundle-size` checks them.
export const SIZE_LIMIT_PACKAGES = ['packages/webapp', 'packages/chrome-extension'];

// vitest projects whose per-test timings are gated, and the test-file prefix
// that identifies each one inside a timing report. The vitest json reporter
// records the file path but not the project name, so a full-repo run is
// partitioned by path.
export const TIMED_PROJECTS = {
  webapp: 'packages/webapp/tests/',
  'node-server': 'packages/node-server/tests/',
  'chrome-extension': 'packages/chrome-extension/tests/',
};

export const TIMING_METRIC = 'p95Ms';

// size-limit parses limits with decimal SI units (kB = 1000 bytes), so a
// budget written "31 MB" is 31_000_000 bytes in its JSON output.
const BYTE_UNITS = { B: 1, kB: 1000, MB: 1e6, GB: 1e9 };

// "24 kB" -> { amount: 24, unit: 'kB', bytes: 24000 }. Returns null for a
// shape this ratchet must not rewrite (percentages, gzip specs, typos), so
// callers skip instead of guessing a budget.
export function parseByteLimit(limit) {
  if (typeof limit !== 'string') return null;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(B|kB|MB|GB)\s*$/.exec(limit);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2];
  return { amount, unit, bytes: amount * BYTE_UNITS[unit] };
}

export function formatByteLimit(amount, unit) {
  return `${amount} ${unit}`;
}

// Tighten one size-limit budget toward its measured size. Rounds to a whole
// unit of the budget's own declared unit so "1850 kB" stays kB and "31 MB"
// stays MB — each ratchet step remains a single reviewable number.
// Returns null when the budget cannot be parsed or does not move.
export function nextByteLimit(limit, actualBytes) {
  const parsed = parseByteLimit(limit);
  if (!parsed) return null;
  if (typeof actualBytes !== 'number' || !Number.isFinite(actualBytes) || actualBytes < 0) {
    return null;
  }
  const factor = BYTE_UNITS[parsed.unit];
  const nextAmount = nextCeiling(parsed.amount, actualBytes / factor, {
    granularity: 1,
    marginRatio: BYTES_MARGIN_RATIO,
  });
  if (nextAmount >= parsed.amount) return null;
  return {
    limit: formatByteLimit(nextAmount, parsed.unit),
    from: parsed.amount,
    to: nextAmount,
    unit: parsed.unit,
    actualBytes,
  };
}

// `size-limit --json` emits [{ name, size, sizeLimit, passed }].
export function parseSizeLimitJson(report) {
  const sizes = {};
  if (!Array.isArray(report)) return sizes;
  for (const entry of report) {
    if (entry && typeof entry.name === 'string' && typeof entry.size === 'number') {
      sizes[entry.name] = entry.size;
    }
  }
  return sizes;
}

// Which size-limit budgets in a package.json tighten against measured sizes,
// matched by budget `name`. Pure; the text edits happen in writeSizeLimits.
export function ratchetSizeLimits(pkgJson, measuredByName) {
  const budgets = pkgJson?.['size-limit'];
  if (!Array.isArray(budgets)) return [];
  const changes = [];
  for (const budget of budgets) {
    const actual = measuredByName?.[budget?.name];
    if (typeof actual !== 'number') continue;
    const change = nextByteLimit(budget.limit, actual);
    if (change) changes.push({ name: budget.name, ...change });
  }
  return changes;
}

// The ceiling files are prettier-formatted (inline arrays, specific key order),
// so they are patched textually rather than round-tripped through
// JSON.stringify, which would reflow every array in the document.
export function replaceJsonNumber(text, key, value) {
  const pattern = new RegExp(`("${key}":\\s*)-?\\d+(?:\\.\\d+)?`);
  if (!pattern.test(text)) return null;
  return text.replace(pattern, (_match, prefix) => `${prefix}${value}`);
}

export function replaceSizeLimit(text, name, limit) {
  const nameIndex = text.indexOf(`"name": ${JSON.stringify(name)}`);
  if (nameIndex === -1) return null;
  const match = /"limit":\s*"[^"]*"/.exec(text.slice(nameIndex));
  if (!match) return null;
  const start = nameIndex + match.index;
  return `${text.slice(0, start)}"limit": ${JSON.stringify(limit)}${text.slice(start + match[0].length)}`;
}

// jscpd's json reporter reports the duplicated-*line* percentage as
// statistics.total.percentage — the same number its `threshold` reporter gates.
export function parseJscpdPercentage(report) {
  const pct = report?.statistics?.total?.percentage;
  return typeof pct === 'number' && Number.isFinite(pct) ? pct : null;
}

export function nextDuplicationThreshold(current, actualPct) {
  const to = nextCeiling(current, actualPct, {
    granularity: DUPLICATION_GRANULARITY,
    margin: DUPLICATION_MARGIN,
  });
  if (to === null) return null;
  if (typeof current === 'number' && to >= current) return null;
  return { from: typeof current === 'number' ? current : null, to, actual: actualPct };
}

function percentile(sortedValues, fraction) {
  if (sortedValues.length === 0) return null;
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(fraction * sortedValues.length) - 1)
  );
  return sortedValues[index];
}

// A test that was retried reports `status: 'passed'` with the failed attempt's
// message still in `failureMessages`, and its `duration` is the *sum* of all
// attempts (a 120 ms test that fails once reports ~245 ms). CI enables one
// retry for node-server and chrome-extension, so those inflated samples are
// excluded from the measurement rather than allowed to push a ceiling up.
export function isRetriedResult(result) {
  return result?.status === 'passed' && (result.failureMessages?.length ?? 0) > 0;
}

// Reduce a vitest json report to a per-test duration summary for one project.
// p95 is the gated metric: it is an order statistic over hundreds of tests, so
// a single slow sample cannot move it, whereas the slowest test is one noisy
// sample that would ratchet the ceiling onto runner noise and then fail
// unrelated PRs.
export function summarizeTiming(report, pathPrefix) {
  const durations = [];
  let retried = 0;
  let slowest = null;
  for (const file of report?.testResults ?? []) {
    const name = typeof file?.name === 'string' ? file.name : '';
    if (pathPrefix && !name.includes(pathPrefix)) continue;
    for (const result of file.assertionResults ?? []) {
      if (isRetriedResult(result)) {
        retried += 1;
        continue;
      }
      const duration = result?.duration;
      if (typeof duration !== 'number' || !Number.isFinite(duration)) continue;
      durations.push(duration);
      if (!slowest || duration > slowest.durationMs) {
        slowest = { fullName: result.fullName, durationMs: duration };
      }
    }
  }
  if (durations.length === 0) return null;
  durations.sort((a, b) => a - b);
  return {
    tests: durations.length,
    retried,
    p95Ms: Math.round(percentile(durations, 0.95) * 100) / 100,
    slowestMs: Math.round(durations[durations.length - 1] * 100) / 100,
    slowestTest: slowest?.fullName ?? null,
  };
}

// The gate side of the timing ceiling. Separated from the IO so the compare
// is unit-testable; `null` inputs mean "nothing to gate on", never a failure.
export function evaluateTiming(summary, ceilingMs) {
  if (!summary) return { status: 'skip', reason: 'no per-test durations in the report' };
  if (typeof ceilingMs !== 'number' || !Number.isFinite(ceilingMs)) {
    return { status: 'skip', reason: 'no ceiling configured', summary };
  }
  return {
    status: summary[TIMING_METRIC] > ceilingMs ? 'fail' : 'pass',
    ceilingMs,
    summary,
  };
}

// Tighten the testTiming section of coverage-thresholds.json. `measured` is
// { project: { p95Ms } }; an unmeasured project is left alone.
export function ratchetTiming(ceilings, measured) {
  const next = structuredClone(ceilings ?? {});
  const changes = [];
  for (const project of Object.keys(TIMED_PROJECTS)) {
    const actual = measured?.[project]?.[TIMING_METRIC];
    if (typeof actual !== 'number' || !Number.isFinite(actual)) continue;
    const current = next[project]?.[TIMING_METRIC];
    const to = nextCeiling(current, actual, {
      granularity: TIMING_GRANULARITY_MS,
      marginRatio: TIMING_MARGIN_RATIO,
    });
    if (to === null) continue;
    if (typeof current === 'number' && to >= current) continue;
    next[project] = { ...next[project], [TIMING_METRIC]: to };
    changes.push({ project, metric: TIMING_METRIC, from: current ?? null, to, actual });
  }
  return { ceilings: next, changes };
}

export function readJscpdConfig() {
  return JSON.parse(readFileSync(jscpdConfigPath, 'utf-8'));
}

export function writeJscpdThreshold(threshold) {
  const patched = replaceJsonNumber(readFileSync(jscpdConfigPath, 'utf-8'), 'threshold', threshold);
  if (!patched) return false;
  writeFileSync(jscpdConfigPath, patched);
  return true;
}

function packageJsonPath(pkgDir) {
  return resolve(repoRoot, pkgDir, 'package.json');
}

export function readPackageJson(pkgDir) {
  return JSON.parse(readFileSync(packageJsonPath(pkgDir), 'utf-8'));
}

export function writeSizeLimits(pkgDir, changes) {
  const path = packageJsonPath(pkgDir);
  let text = readFileSync(path, 'utf-8');
  for (const change of changes) {
    const patched = replaceSizeLimit(text, change.name, change.limit);
    if (!patched) return false;
    text = patched;
  }
  writeFileSync(path, text);
  return true;
}
