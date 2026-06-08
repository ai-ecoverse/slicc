import { describe, expect, it } from 'vitest';
import {
  applyRatchet,
  nextFloor,
  parseVitestSummary,
  ratchetPackage,
} from './coverage-ratchet-lib.mjs';

describe('nextFloor', () => {
  it('floors the measured percentage, keeping <1pp headroom', () => {
    expect(nextFloor(80, 82.03)).toBe(82);
    expect(nextFloor(50, 50.0)).toBe(50);
  });

  it('never lowers an existing floor', () => {
    expect(nextFloor(85, 82.9)).toBe(85);
  });

  it('only steps up in whole points (sub-1pp drift cannot raise it)', () => {
    expect(nextFloor(82, 82.99)).toBe(82);
    expect(nextFloor(82, 83.0)).toBe(83);
  });

  it('treats a missing current floor as zero', () => {
    expect(nextFloor(undefined, 41.7)).toBe(41);
  });
});

describe('ratchetPackage', () => {
  it('raises only metrics that increased and reports the change', () => {
    const { floors, changes } = ratchetPackage(
      { lines: 71, statements: 69, functions: 70, branches: 60 },
      { lines: 73.4, statements: 69.2, functions: 70.9, branches: 61.0 },
      ['lines', 'statements', 'functions', 'branches']
    );
    expect(floors).toEqual({ lines: 73, statements: 69, functions: 70, branches: 61 });
    expect(changes).toEqual([
      { metric: 'lines', from: 71, to: 73, actual: 73.4 },
      { metric: 'branches', from: 60, to: 61, actual: 61.0 },
    ]);
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
        webapp: { lines: 72.5, statements: 69.1, functions: 70.0, branches: 60.0 },
        'chrome-extension': { lines: 69.0, statements: 67.0, functions: 62.0, branches: 56.0 },
      },
      swift: { 'swift-server': { lines: 55.1, functions: 53.0, regions: 49.9 } },
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
