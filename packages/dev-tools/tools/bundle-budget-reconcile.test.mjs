import { describe, expect, it } from 'vitest';
import {
  applyBudgetRaises,
  formatLimit,
  parseLimit,
  planBudgetRaises,
} from './bundle-budget-reconcile-lib.mjs';

describe('parseLimit', () => {
  it('uses size-limit decimal units', () => {
    expect(parseLimit('25.917 MB')).toBe(25_917_000);
    expect(parseLimit('60 kB')).toBe(60_000);
    expect(parseLimit('512 B')).toBe(512);
    expect(parseLimit('25.70 MB')).toBe(25_700_000);
  });

  it('uses size-limit binary units', () => {
    expect(parseLimit('27 MiB')).toBe(28_311_552);
    expect(parseLimit('1.5 KiB')).toBe(1_536);
  });

  it('rejects unknown formats', () => {
    expect(() => parseLimit('1 GiB')).toThrow(/Unsupported/);
    expect(() => parseLimit('')).toThrow(/Unsupported/);
  });
});

describe('formatLimit', () => {
  it('rounds up to the next kB and keeps the unit', () => {
    expect(formatLimit(25_922_494, '25.917 MB')).toBe('25.923 MB');
    expect(formatLimit(25_923_000, '25.917 MB')).toBe('25.923 MB');
    expect(formatLimit(60_001, '60 kB')).toBe('61 kB');
    expect(formatLimit(1_234, '1000 B')).toBe('1234 B');
    expect(formatLimit(28_311_553, '27 MiB')).toBe('27.001 MiB');
    expect(formatLimit(2_049, '2 KiB')).toBe('3 KiB');
  });

  it('never formats below the measured size', () => {
    for (const size of [1, 999, 1000, 25_700_163, 104_079, 28_311_553, 30_000_001]) {
      for (const unit of ['1 MB', '1 kB', '1 MiB', '1 KiB', '1 B']) {
        expect(parseLimit(formatLimit(size, unit))).toBeGreaterThanOrEqual(size);
      }
    }
  });
});

describe('planBudgetRaises', () => {
  const budgets = [
    { name: 'total', limit: '25.917 MB' },
    { name: 'sw', limit: '60 kB' },
  ];

  it('ignores budgets that pass', () => {
    const plan = planBudgetRaises(
      budgets,
      [
        { name: 'total', size: 25_916_383 },
        { name: 'sw', size: 60_000 },
      ],
      { maxGrowthBytes: 50_000 }
    );
    expect(plan).toEqual({ raises: [], blocked: [] });
  });

  it('raises a small overshoot to the measured size', () => {
    const plan = planBudgetRaises(
      budgets,
      [
        { name: 'total', size: 25_922_494 },
        { name: 'sw', size: 59_000 },
      ],
      { maxGrowthBytes: 50_000 }
    );
    expect(plan.blocked).toEqual([]);
    expect(plan.raises).toEqual([
      { name: 'total', from: '25.917 MB', to: '25.923 MB', size: 25_922_494, overBy: 5_494 },
    ]);
  });

  it('blocks an overshoot above the cap', () => {
    const plan = planBudgetRaises(
      budgets,
      [
        { name: 'total', size: 25_917_000 + 50_001 },
        { name: 'sw', size: 59_000 },
      ],
      { maxGrowthBytes: 50_000 }
    );
    expect(plan.raises).toEqual([]);
    expect(plan.blocked).toEqual([
      { name: 'total', from: '25.917 MB', size: 25_967_001, overBy: 50_001 },
    ]);
  });

  it('fails loudly when size-limit omits a budget', () => {
    expect(() =>
      planBudgetRaises(budgets, [{ name: 'total', size: 1 }], { maxGrowthBytes: 0 })
    ).toThrow(/no size for budget "sw"/);
  });
});

describe('applyBudgetRaises', () => {
  const pkg = `{
  "name": "@slicc/x",
  "size-limit": [
    {
      "name": "a",
      "path": "a.js",
      "limit": "60 kB"
    },
    {
      "name": "b",
      "path": "b.js",
      "brotli": false,
      "limit": "60 kB"
    }
  ]
}
`;

  it('rewrites only the named budget and preserves formatting', () => {
    const out = applyBudgetRaises(pkg, [{ name: 'b', from: '60 kB', to: '61 kB' }]);
    expect(out).toBe(
      pkg.replace(
        '"brotli": false,\n      "limit": "60 kB"',
        '"brotli": false,\n      "limit": "61 kB"'
      )
    );
    expect(JSON.parse(out)['size-limit'].map((e) => e.limit)).toEqual(['60 kB', '61 kB']);
  });

  it('throws when the budget cannot be found', () => {
    expect(() => applyBudgetRaises(pkg, [{ name: 'c', from: '60 kB', to: '61 kB' }])).toThrow(
      /Could not find the "c" budget/
    );
  });
});
