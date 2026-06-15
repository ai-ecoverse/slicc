import { describe, expect, it } from 'vitest';
import {
  applyRatchet,
  nextFloor,
  parseVitestSummary,
  ratchetPackage,
} from './coverage-ratchet-lib.mjs';

describe('nextFloor', () => {
  it('subtracts the half-point safety margin before flooring (~0.5-1.5pp headroom)', () => {
    expect(nextFloor(80, 82.03)).toBe(81);
    expect(nextFloor(50, 50.6)).toBe(50);
  });

  it('never lowers an existing floor', () => {
    expect(nextFloor(85, 82.9)).toBe(85);
    expect(nextFloor(50, 50.0)).toBe(50);
  });

  it('needs >=0.5pp clearance to raise a floor (whole-point steps)', () => {
    expect(nextFloor(82, 82.99)).toBe(82);
    expect(nextFloor(82, 83.49)).toBe(82);
    expect(nextFloor(82, 83.5)).toBe(83);
  });

  it('treats a missing current floor as zero', () => {
    expect(nextFloor(undefined, 41.7)).toBe(41);
  });

  // Regression for PR #1015's webapp branches miss: 62 -> 63 was set with
  // only ~0.06pp headroom and the next CI run measured 62.94 (failure).
  // With the 0.5pp margin, 63.06 must keep the floor at 62.
  it('keeps the floor when measurement is within the margin of the next integer (PR #1015 miss)', () => {
    expect(nextFloor(62, 63.06)).toBe(62);
    expect(nextFloor(62, 63.6)).toBe(63);
  });
});

describe('ratchetPackage', () => {
  it('raises only metrics that clear the safety margin and reports the change', () => {
    const { floors, changes } = ratchetPackage(
      { lines: 71, statements: 69, functions: 70, branches: 60 },
      { lines: 73.9, statements: 69.2, functions: 70.9, branches: 61.0 },
      ['lines', 'statements', 'functions', 'branches']
    );
    expect(floors).toEqual({ lines: 73, statements: 69, functions: 70, branches: 60 });
    expect(changes).toEqual([{ metric: 'lines', from: 71, to: 73, actual: 73.9 }]);
  });

  it('ignores missing/NaN measurements', () => {
    const { floors, changes } = ratchetPackage({ lines: 50 }, { lines: Number.NaN }, [
      'lines',
      'branches',
    ]);
    expect(floors).toEqual({ lines: 50 });
    expect(changes).toEqual([]);
  });
});

describe('applyRatchet', () => {
  it('ratchets both groups and preserves untouched fields', () => {
    const thresholds = {
      typescript: {
        webapp: { lines: 71, statements: 69, functions: 70, branches: 60 },
        'chrome-extension': {
          lines: 69,
          statements: 67,
          functions: 62,
          branches: 56,
          coverageExclude: ['**/dist/**'],
        },
      },
      swift: { 'swift-server': { lines: 53, functions: 53, regions: 48 } },
    };
    const measured = {
      typescript: {
        webapp: { lines: 72.9, statements: 69.1, functions: 70.0, branches: 60.0 },
        'chrome-extension': { lines: 69.0, statements: 67.0, functions: 62.0, branches: 56.0 },
      },
      swift: { 'swift-server': { lines: 55.7, functions: 53.0, regions: 49.9 } },
    };
    const { thresholds: next, changes } = applyRatchet(thresholds, measured);

    expect(next.typescript.webapp.lines).toBe(72);
    expect(next.typescript['chrome-extension'].coverageExclude).toEqual(['**/dist/**']);
    expect(next.swift['swift-server']).toEqual({ lines: 55, functions: 53, regions: 49 });
    expect(thresholds.typescript.webapp.lines).toBe(71); // input not mutated
    expect(changes.map((c) => `${c.package}.${c.metric}`)).toEqual([
      'webapp.lines',
      'swift-server.lines',
      'swift-server.regions',
    ]);
  });

  it('skips packages with no measurement', () => {
    const thresholds = { typescript: { webapp: { lines: 50 } }, swift: {} };
    const { thresholds: next, changes } = applyRatchet(thresholds, { typescript: {}, swift: {} });
    expect(next).toEqual(thresholds);
    expect(changes).toEqual([]);
  });
});

describe('parseVitestSummary', () => {
  it('extracts total percentages for each metric', () => {
    const summary = {
      total: {
        lines: { pct: 71.05 },
        statements: { pct: 69.18 },
        functions: { pct: 70.56 },
        branches: { pct: 60.5 },
      },
    };
    expect(parseVitestSummary(summary)).toEqual({
      lines: 71.05,
      statements: 69.18,
      functions: 70.56,
      branches: 60.5,
    });
  });
});
