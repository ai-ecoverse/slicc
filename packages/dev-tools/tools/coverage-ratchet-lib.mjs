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
// with percentage values. Preserves untouched fields (e.g. coverageExclude).
export function applyRatchet(thresholds, measured) {
  const next = structuredClone(thresholds);
  const changes = [];
  for (const [group, metrics] of [
    ['typescript', TS_METRICS],
    ['swift', SWIFT_METRICS],
  ]) {
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
