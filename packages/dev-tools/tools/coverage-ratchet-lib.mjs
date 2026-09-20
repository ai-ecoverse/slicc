import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const thresholdsPath = resolve(repoRoot, 'coverage-thresholds.json');

export const TS_METRICS = ['lines', 'statements', 'functions', 'branches'];
export const SWIFT_METRICS = ['lines', 'functions', 'regions'];

export const SWIFT_BUNDLES = {
  'swift-server': 'SliccServerPackageTests',
  'swift-optel': 'SwiftOptelPackageTests',
  'swift-traysession': 'SliccTraySessionPackageTests',
  'swift-trayfollower': 'SliccTrayFollowerPackageTests',
  'swift-traykit': 'SliccTrayVFSPackageTests',
  'swift-widgetkit': 'SliccWidgetKitPackageTests',
  'swift-launcher': 'SliccstartPackageTests',

  'ios-app': { bundle: 'SliccFollower', xcodebuildScheme: 'SliccFollower' },
};

export const MARGIN = 0.5;

export function nextFloor(currentFloor, actualPct) {
  const candidate = Math.floor(actualPct - MARGIN);
  const current = typeof currentFloor === 'number' ? currentFloor : 0;
  return Math.max(current, candidate);
}

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
