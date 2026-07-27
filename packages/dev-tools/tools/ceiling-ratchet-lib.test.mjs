import { describe, expect, it } from 'vitest';
import {
  formatByteLimit,
  isRetriedResult,
  nextByteLimit,
  nextDuplicationThreshold,
  parseByteLimit,
  parseJscpdPercentage,
  parseSizeLimitJson,
  ratchetSizeLimits,
  ratchetTiming,
  replaceJsonNumber,
  replaceSizeLimit,
  SIZE_LIMIT_PACKAGES,
  summarizeTiming,
  TIMED_PROJECTS,
} from './ceiling-ratchet-lib.mjs';

describe('parseByteLimit', () => {
  it('parses the decimal SI units size-limit uses', () => {
    expect(parseByteLimit('24 kB')).toEqual({ amount: 24, unit: 'kB', bytes: 24000 });
    expect(parseByteLimit('31 MB')).toEqual({ amount: 31, unit: 'MB', bytes: 31000000 });
    expect(parseByteLimit('1850kB')).toEqual({ amount: 1850, unit: 'kB', bytes: 1850000 });
    expect(parseByteLimit('1.5 MB').bytes).toBe(1500000);
  });

  it('refuses shapes it must not rewrite', () => {
    expect(parseByteLimit('10%')).toBe(null);
    expect(parseByteLimit('24 kb')).toBe(null);
    expect(parseByteLimit(24)).toBe(null);
    expect(parseByteLimit(undefined)).toBe(null);
  });
});

describe('nextByteLimit', () => {
  it('tightens toward the measured size with 5% headroom, in the declared unit', () => {
    expect(nextByteLimit('24 kB', 21388)).toMatchObject({ limit: '23 kB', from: 24, to: 23 });
    expect(nextByteLimit('1850 kB', 1681923)).toMatchObject({ limit: '1767 kB', to: 1767 });
    expect(nextByteLimit('60 kB', 55858)).toMatchObject({ limit: '59 kB' });
    expect(nextByteLimit('105 kB', 95627)).toMatchObject({ limit: '101 kB' });
  });

  it('does not move when the margin already fills the budget', () => {
    // 29.63 MB * 1.05 rounds up to 32 MB, which is looser than 31 MB.
    expect(nextByteLimit('31 MB', 29627990)).toBe(null);
    expect(nextByteLimit('24 kB', 23000)).toBe(null);
  });

  it('never loosens a budget the bundle already exceeds', () => {
    expect(nextByteLimit('24 kB', 30000)).toBe(null);
  });

  it('skips unparseable budgets and missing measurements', () => {
    expect(nextByteLimit('lots', 100)).toBe(null);
    expect(nextByteLimit('24 kB', undefined)).toBe(null);
    expect(nextByteLimit('24 kB', Number.NaN)).toBe(null);
  });
});

describe('formatByteLimit', () => {
  it('round-trips through parseByteLimit', () => {
    expect(parseByteLimit(formatByteLimit(23, 'kB'))).toEqual({
      amount: 23,
      unit: 'kB',
      bytes: 23000,
    });
  });
});

describe('parseSizeLimitJson', () => {
  it('maps budget name to measured bytes', () => {
    expect(
      parseSizeLimitJson([
        { name: 'a', size: 10, sizeLimit: 20, passed: true },
        { name: 'b', size: 30 },
      ])
    ).toEqual({ a: 10, b: 30 });
  });

  it('tolerates junk', () => {
    expect(parseSizeLimitJson(null)).toEqual({});
    expect(parseSizeLimitJson([{ name: 'a' }, null, { size: 1 }])).toEqual({});
  });
});

describe('ratchetSizeLimits', () => {
  const pkgJson = {
    name: '@slicc/webapp',
    'size-limit': [
      { name: 'main', path: 'a.js', limit: '24 kB' },
      { name: 'total', path: '**/*.js', limit: '31 MB' },
    ],
  };

  it('reports only the budgets that tighten', () => {
    const changes = ratchetSizeLimits(pkgJson, { main: 21388, total: 29627990 });
    expect(changes).toEqual([
      { name: 'main', limit: '23 kB', from: 24, to: 23, unit: 'kB', actualBytes: 21388 },
    ]);
  });

  it('ignores budgets with no measurement and packages with no block', () => {
    expect(ratchetSizeLimits(pkgJson, { other: 1 })).toEqual([]);
    expect(ratchetSizeLimits({ name: 'x' }, { main: 1 })).toEqual([]);
    expect(ratchetSizeLimits(undefined, {})).toEqual([]);
  });

  it('covers the packages npm run bundle-size checks', () => {
    expect(SIZE_LIMIT_PACKAGES).toEqual(['packages/webapp', 'packages/chrome-extension']);
  });
});

describe('replaceJsonNumber', () => {
  const text = '{\n  "minTokens": 50,\n  "threshold": 7.5,\n  "path": ["packages"]\n}\n';

  it('patches the value in place without reflowing the document', () => {
    expect(replaceJsonNumber(text, 'threshold', 7.4)).toBe(
      '{\n  "minTokens": 50,\n  "threshold": 7.4,\n  "path": ["packages"]\n}\n'
    );
  });

  it('returns null when the key is absent', () => {
    expect(replaceJsonNumber(text, 'nope', 1)).toBe(null);
  });
});

describe('replaceSizeLimit', () => {
  const text = [
    '{',
    '  "size-limit": [',
    '    {',
    '      "name": "webapp: main entry chunk",',
    '      "path": "../../dist/ui/assets/main-*.js",',
    '      "brotli": false,',
    '      "limit": "24 kB"',
    '    },',
    '    {',
    '      "name": "webapp: kernel worker",',
    '      "limit": "1850 kB"',
    '    }',
    '  ]',
    '}',
    '',
  ].join('\n');

  it('patches the limit belonging to the named budget only', () => {
    const patched = replaceSizeLimit(text, 'webapp: kernel worker', '1767 kB');
    expect(patched).toContain('"limit": "1767 kB"');
    expect(patched).toContain('"limit": "24 kB"');
    expect(patched.replace('1767 kB', '1850 kB')).toBe(text);
  });

  it('returns null for an unknown budget or a missing limit', () => {
    expect(replaceSizeLimit(text, 'nope', '1 kB')).toBe(null);
    expect(
      replaceSizeLimit('{ "name": "webapp: main entry chunk" }', 'webapp: main entry chunk', '1 kB')
    ).toBe(null);
  });
});

describe('parseJscpdPercentage', () => {
  it('reads the duplicated-line percentage jscpd gates on', () => {
    expect(parseJscpdPercentage({ statistics: { total: { percentage: 7.0316 } } })).toBe(7.0316);
  });

  it('returns null when the report has no total', () => {
    expect(parseJscpdPercentage({})).toBe(null);
    expect(parseJscpdPercentage({ statistics: { total: { percentage: 'x' } } })).toBe(null);
  });
});

describe('nextDuplicationThreshold', () => {
  it('tightens in tenths of a point with 0.3pp of headroom', () => {
    expect(nextDuplicationThreshold(7.5, 7.0316)).toEqual({ from: 7.5, to: 7.4, actual: 7.0316 });
  });

  it('does not move when the headroom is already thin', () => {
    expect(nextDuplicationThreshold(7.5, 7.25)).toBe(null);
    expect(nextDuplicationThreshold(7.5, 8.1)).toBe(null);
  });

  it('skips a missing measurement', () => {
    expect(nextDuplicationThreshold(7.5, null)).toBe(null);
  });
});

describe('isRetriedResult', () => {
  it('detects a test that failed an attempt and then passed', () => {
    expect(isRetriedResult({ status: 'passed', failureMessages: ['AssertionError'] })).toBe(true);
  });

  it('does not flag a clean pass or an outright failure', () => {
    expect(isRetriedResult({ status: 'passed', failureMessages: [] })).toBe(false);
    expect(isRetriedResult({ status: 'failed', failureMessages: ['boom'] })).toBe(false);
    expect(isRetriedResult(null)).toBe(false);
  });
});

describe('summarizeTiming', () => {
  const report = {
    testResults: [
      {
        name: '/repo/packages/webapp/tests/a.test.ts',
        assertionResults: [
          { fullName: 'a1', status: 'passed', duration: 10, failureMessages: [] },
          { fullName: 'a2', status: 'passed', duration: 900, failureMessages: [] },
          // Retried: 245 ms is the *sum* of a failed and a passing attempt.
          { fullName: 'a3', status: 'passed', duration: 245, failureMessages: ['AssertionError'] },
          { fullName: 'a4', status: 'skipped', duration: null, failureMessages: [] },
        ],
      },
      {
        name: '/repo/packages/node-server/tests/b.test.ts',
        assertionResults: [{ fullName: 'b1', status: 'passed', duration: 5000 }],
      },
    ],
  };

  it('summarizes only the requested project and excludes retried samples', () => {
    const summary = summarizeTiming(report, TIMED_PROJECTS.webapp);
    expect(summary).toEqual({
      tests: 2,
      retried: 1,
      p95Ms: 900,
      slowestMs: 900,
      slowestTest: 'a2',
    });
  });

  it('partitions by project path', () => {
    expect(summarizeTiming(report, TIMED_PROJECTS['node-server']).p95Ms).toBe(5000);
  });

  it('returns null when nothing usable was measured', () => {
    expect(summarizeTiming(report, 'packages/cherry/tests/')).toBe(null);
    expect(summarizeTiming({}, null)).toBe(null);
    expect(summarizeTiming(undefined, null)).toBe(null);
  });

  it('takes p95 as an order statistic, so one slow test cannot move it', () => {
    const many = {
      testResults: [
        {
          name: 'packages/webapp/tests/x.test.ts',
          assertionResults: Array.from({ length: 100 }, (_, i) => ({
            fullName: `t${i}`,
            status: 'passed',
            duration: i === 99 ? 60000 : 10,
            failureMessages: [],
          })),
        },
      ],
    };
    const summary = summarizeTiming(many, TIMED_PROJECTS.webapp);
    expect(summary.p95Ms).toBe(10);
    expect(summary.slowestMs).toBe(60000);
  });
});

describe('ratchetTiming', () => {
  it('tightens a ceiling with 4x headroom at 50 ms steps', () => {
    const { ceilings, changes } = ratchetTiming(
      { webapp: { p95Ms: 4000 }, 'node-server': { p95Ms: 1000 } },
      { webapp: { p95Ms: 620 }, 'node-server': { p95Ms: 700 } }
    );
    expect(ceilings.webapp.p95Ms).toBe(2500);
    expect(ceilings['node-server'].p95Ms).toBe(1000);
    expect(changes).toEqual([
      { project: 'webapp', metric: 'p95Ms', from: 4000, to: 2500, actual: 620 },
    ]);
  });

  it('seeds a ceiling for a project that has none yet', () => {
    const { ceilings, changes } = ratchetTiming({}, { webapp: { p95Ms: 300 } });
    expect(ceilings.webapp).toEqual({ p95Ms: 1200 });
    expect(changes[0]).toMatchObject({ from: null, to: 1200 });
  });

  it('leaves unmeasured projects and unknown keys alone', () => {
    const { ceilings, changes } = ratchetTiming({ webapp: { p95Ms: 900 } }, {});
    expect(ceilings).toEqual({ webapp: { p95Ms: 900 } });
    expect(changes).toEqual([]);
  });
});
