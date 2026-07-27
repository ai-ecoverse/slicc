import { describe, expect, it } from 'vitest';
import {
  applyRatchet,
  BYTES_MARGIN_RATIO,
  DUPLICATION_GRANULARITY,
  DUPLICATION_MARGIN,
  FLOOR_GROUPS,
  nextCeiling,
  nextFloor,
  parseVitestSummary,
  ratchetPackage,
  TIMING_GRANULARITY_MS,
  TIMING_MARGIN_RATIO,
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

describe('nextCeiling', () => {
  const duplication = {
    granularity: DUPLICATION_GRANULARITY,
    margin: DUPLICATION_MARGIN,
  };

  it('tightens a ceiling toward the measurement at the configured granularity', () => {
    expect(nextCeiling(7.5, 7.07, duplication)).toBe(7.4);
    expect(nextCeiling(7.4, 6.5, duplication)).toBe(6.8);
  });

  it('never raises a ceiling', () => {
    expect(nextCeiling(7.5, 7.4, duplication)).toBe(7.5);
    expect(nextCeiling(7.5, 9, duplication)).toBe(7.5);
  });

  it('returns the current ceiling unchanged when tightening is not justified', () => {
    // The whole-point mirror of nextFloor would propose Math.ceil(7.07 + 0.5)
    // = 8 here, i.e. a *looser* budget than the 7.5 already in the tree.
    expect(nextCeiling(7.5, 7.07, { granularity: 1, margin: 0.5 })).toBe(7.5);
  });

  it('applies a proportional margin for byte budgets', () => {
    const bytes = { granularity: 1, marginRatio: BYTES_MARGIN_RATIO };
    expect(nextCeiling(24, 21.39, bytes)).toBe(23);
    expect(nextCeiling(60, 55.86, bytes)).toBe(59);
    // 29.62 MB * 1.05 = 31.1 MB, which does not fit under a 31 MB budget.
    expect(nextCeiling(31, 29.62, bytes)).toBe(31);
  });

  it('keeps 2x headroom at 50 ms steps for durations', () => {
    const timing = { granularity: TIMING_GRANULARITY_MS, marginRatio: TIMING_MARGIN_RATIO };
    expect(nextCeiling(4000, 620, timing)).toBe(1250);
    expect(nextCeiling(1250, 700, timing)).toBe(1250);
  });

  it('adopts the measurement when no ceiling exists yet', () => {
    expect(nextCeiling(undefined, 7.07, duplication)).toBe(7.4);
    expect(nextCeiling(null, 7.07, duplication)).toBe(7.4);
  });

  it('never moves on a missing or nonsense measurement', () => {
    expect(nextCeiling(7.5, Number.NaN, duplication)).toBe(7.5);
    expect(nextCeiling(7.5, undefined, duplication)).toBe(7.5);
    expect(nextCeiling(7.5, -1, duplication)).toBe(7.5);
    expect(nextCeiling(undefined, Number.NaN, duplication)).toBe(null);
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

  it('ratchets every declared floor group, including go', () => {
    const thresholds = {
      typescript: {},
      swift: {},
      go: { 'slicc-cli': { statements: 58 } },
      testTiming: { webapp: { p95Ms: 1250 } },
    };
    const { thresholds: next, changes } = applyRatchet(thresholds, {
      go: { 'slicc-cli': { statements: 61.4 } },
    });
    expect(next.go['slicc-cli'].statements).toBe(60);
    expect(next.testTiming).toEqual({ webapp: { p95Ms: 1250 } });
    expect(changes).toEqual([
      { group: 'go', package: 'slicc-cli', metric: 'statements', from: 58, to: 60, actual: 61.4 },
    ]);
  });

  it('declares one metric list per floor group', () => {
    expect(Object.keys(FLOOR_GROUPS)).toEqual(['typescript', 'swift', 'go']);
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
