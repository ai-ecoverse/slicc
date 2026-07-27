// Shared logic for the coverage gate and the nightly coverage ratchet.
//
// The pure functions here (no IO) are unit-tested by the `dev-tools`
// vitest project. The thin IO helpers at the bottom are exercised by the
// CLIs (coverage-gate.mjs, coverage-ratchet.mjs).

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const thresholdsPath = resolve(repoRoot, 'coverage-thresholds.json');

export const TS_METRICS = ['lines', 'statements', 'functions', 'branches'];
export const SWIFT_METRICS = ['lines', 'functions', 'regions'];
// Go reports a single total-statement percentage (`go tool cover -func`).
export const GO_METRICS = ['statements'];

// Every floor group in coverage-thresholds.json and the metrics it carries.
// applyRatchet walks this map instead of a hardcoded list, so adding a
// language means adding one entry here. Ceiling sections of the same file
// (e.g. testTiming) are deliberately absent: they ratchet downward through
// ratchetCeilings, not upward through ratchetPackage.
export const FLOOR_GROUPS = {
  typescript: TS_METRICS,
  swift: SWIFT_METRICS,
  go: GO_METRICS,
};

// Half-point safety margin subtracted before flooring, so a measurement
// like 63.06% won't ratchet a floor to 63 (which a 0.1pp jitter on the
// next run could miss). With MARGIN = 0.5 the effective headroom below
// measured coverage is ~0.5-1.5pp. See PR #1015's webapp branches miss
// (62 -> 63 set with only 0.06pp headroom, failed CI next run).
export const MARGIN = 0.5;

// A floor only ever moves up, and it tracks the integer part of the
// measured percentage minus MARGIN. Each ratchet step is still a clean,
// reviewable whole-point bump.
export function nextFloor(currentFloor, actualPct) {
  const candidate = Math.floor(actualPct - MARGIN);
  const current = typeof currentFloor === 'number' ? currentFloor : 0;
  return Math.max(current, candidate);
}

// Round up to the next multiple of `step`, tolerating binary-float error so
// 7.37 at a 0.1 step lands on 7.4 rather than 7.4000000000000005.
function ceilTo(value, step) {
  const rounded = Math.ceil(value / step - 1e-9) * step;
  return Number(rounded.toFixed(10));
}

// The ceiling mirror of nextFloor: a budget only ever moves *down*, toward the
// measurement, and never below it plus a safety margin. Returns the unchanged
// ceiling when the measurement does not justify tightening (the "never move"
// result), so callers can compare against the input to detect a change.
//
// Unlike floors, ceilings need per-metric granularity and margin *style*
// (see the constants below): a straight mirror of nextFloor's whole-point step
// would never tighten a 7.5% duplication budget measured at 7.07%, because
// Math.ceil(7.07 + 0.5) = 8 is looser than the budget it replaces.
export function nextCeiling(
  currentCeiling,
  actual,
  { granularity = 1, margin = 0, marginRatio = 0 } = {}
) {
  const current =
    typeof currentCeiling === 'number' && Number.isFinite(currentCeiling) ? currentCeiling : null;
  if (typeof actual !== 'number' || !Number.isFinite(actual) || actual < 0) return current;
  const candidate = ceilTo(actual + margin + actual * marginRatio, granularity);
  return current === null ? candidate : Math.min(current, candidate);
}

// Duplication is a percentage like a coverage floor, but the budget lives one
// order of magnitude finer (7.5%, not 75%), so whole-point steps are useless
// here. 0.1pp granularity with a 0.3pp additive margin keeps 0.3-0.4pp of
// headroom — the same headroom jscpd.json already documents, and the same
// role MARGIN = 0.5 plays for floors (see PR #1015): enough slack that
// ordinary churn cannot flip the gate red on the next run, while each ratchet
// step is still a single reviewable tenth of a point.
export const DUPLICATION_GRANULARITY = 0.1;
export const DUPLICATION_MARGIN = 0.3;

// Bundle bytes need a *proportional* margin, not an additive one: a 21 kB
// entry chunk and a 31 MB payload jitter by wildly different absolute amounts
// on an ordinary dependency bump. 5% headroom absorbs that; a tighter
// auto-lowered byte ceiling would fail unrelated PRs, which is exactly how a
// ratchet loses its credibility. Rounding is to a whole unit of the budget's
// own declared unit (kB or MB), so each step stays reviewable.
export const BYTES_MARGIN_RATIO = 0.05;

// Test durations are the noisiest signal of the three: the nightly ratchet
// measures on macos-latest while the gate runs on ubuntu-latest, and both are
// shared runners under variable load — a factor-of-two spread between the two
// for the same test is ordinary. That dwarfs the ~0.5pp jitter MARGIN was
// sized for, so the timing ceiling keeps 4x the measured p95, rounded to
// 50 ms. Deliberately loose: the metric exists to catch order-of-magnitude
// drift (every test suddenly waiting on a 500 ms timeout), not to police 10%
// regressions, and a ceiling that fires on unrelated PRs would discredit the
// whole ratchet faster than the drift it watches.
export const TIMING_MARGIN_RATIO = 3;
export const TIMING_GRANULARITY_MS = 50;

// Compute ratcheted floors for one package against measured percentages.
// Returns the new floor map plus a per-metric change list (only metrics
// that actually increased).
export function ratchetPackage(currentFloors, measuredPct, metrics) {
  const floors = { ...currentFloors };
  const changes = [];
  for (const metric of metrics) {
    const actual = measuredPct[metric];
    if (typeof actual !== 'number' || Number.isNaN(actual)) continue;
    const from = typeof currentFloors[metric] === 'number' ? currentFloors[metric] : 0;
    const to = nextFloor(from, actual);
    if (to > from) {
      floors[metric] = to;
      changes.push({ metric, from, to, actual });
    }
  }
  return { floors, changes };
}

// Apply the ratchet across the whole thresholds document. `measured` mirrors
// the thresholds shape: { typescript: { pkg: { lines, ... } }, swift: { ... } }
// with percentage values. Preserves untouched fields (e.g. coverageExclude)
// and every non-floor section of the document (e.g. testTiming ceilings).
export function applyRatchet(thresholds, measured) {
  const next = structuredClone(thresholds);
  const changes = [];
  for (const [group, metrics] of Object.entries(FLOOR_GROUPS)) {
    const groupFloors = next[group] ?? {};
    const groupMeasured = measured[group] ?? {};
    for (const pkg of Object.keys(groupFloors)) {
      if (!groupMeasured[pkg]) continue;
      const { floors, changes: pkgChanges } = ratchetPackage(
        groupFloors[pkg],
        groupMeasured[pkg],
        metrics
      );
      groupFloors[pkg] = floors;
      for (const c of pkgChanges) changes.push({ group, package: pkg, ...c });
    }
  }
  return { thresholds: next, changes };
}

// Pull total percentages out of a vitest v8 json-summary report.
export function parseVitestSummary(summaryJson) {
  const total = summaryJson.total ?? {};
  const out = {};
  for (const metric of TS_METRICS) {
    if (typeof total[metric]?.pct === 'number') out[metric] = total[metric].pct;
  }
  return out;
}

export function readThresholds() {
  return JSON.parse(readFileSync(thresholdsPath, 'utf-8'));
}

export function writeThresholds(thresholds) {
  writeFileSync(thresholdsPath, `${JSON.stringify(thresholds, null, 2)}\n`);
}
