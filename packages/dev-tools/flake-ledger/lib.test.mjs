import { describe, expect, it } from 'vitest';
import {
  aggregateFlakes,
  extractFlakesFromLedger,
  extractFlakesFromVitestJson,
  FLAKE_LABEL,
  fingerprint,
  inferProject,
  LEDGER_KIND,
  normalizeTestName,
  parseFingerprints,
  parseReport,
  partitionFlakes,
  renderIssueBody,
  renderIssueTitle,
  renderRecurrenceComment,
  toRepoRelativePath,
} from './lib.mjs';

/**
 * Real `vitest.json` excerpt captured from vitest 4.1.10 with `--retry=1`:
 * the flaky test is `passed` yet still carries the losing attempt's error,
 * the genuine failure is `failed` with one message per attempt, and the clean
 * pass (plus an `it.fails` expected failure) carries none.
 */
const VITEST_JSON = {
  numTotalTests: 4,
  numPassedTests: 3,
  numFailedTests: 1,
  success: false,
  testResults: [
    {
      name: '/home/runner/work/slicc/slicc/packages/chrome-extension/tests/probe.test.ts',
      status: 'failed',
      assertionResults: [
        {
          ancestorTitles: ['flake probe'],
          fullName: 'flake probe passes only on the second attempt',
          title: 'passes only on the second attempt',
          status: 'passed',
          duration: 1.96,
          failureMessages: [
            'AssertionError: probe attempt 1 is deliberately failing: expected 1 to be greater than 1\n    at probe.test.ts:7:5',
          ],
        },
        {
          ancestorTitles: ['flake probe'],
          fullName: 'flake probe fails on every attempt',
          title: 'fails on every attempt',
          status: 'failed',
          duration: 1.65,
          failureMessages: [
            "AssertionError: expected 'genuinely broken' to be 'never fixed'",
            "AssertionError: expected 'genuinely broken' to be 'never fixed'",
          ],
        },
        {
          ancestorTitles: ['flake probe'],
          fullName: 'flake probe passes first try',
          title: 'passes first try',
          status: 'passed',
          duration: 0.06,
          failureMessages: [],
        },
        {
          ancestorTitles: ['flake probe'],
          fullName: 'flake probe is an expected failure',
          title: 'is an expected failure',
          status: 'passed',
          duration: 0.1,
          failureMessages: [],
        },
      ],
    },
  ],
};

/** Real `flakes.json` excerpt from `flake-reporter.mjs` on the same run. */
const LEDGER_JSON = {
  kind: LEDGER_KIND,
  version: 1,
  generatedAt: '2026-07-27T16:37:59.700Z',
  flakes: [
    {
      project: 'chrome-extension',
      file: 'packages/chrome-extension/tests/probe.test.ts',
      testName: 'flake probe > passes only on the second attempt',
      retryCount: 1,
      failureMessage: 'probe attempt 1 is deliberately failing: expected 1 to be greater than 1',
    },
  ],
};

describe('toRepoRelativePath', () => {
  it('strips a CI runner prefix down to the packages/ root', () => {
    expect(
      toRepoRelativePath('/home/runner/work/slicc/slicc/packages/webapp/tests/a.test.ts')
    ).toBe('packages/webapp/tests/a.test.ts');
  });
  it('normalizes windows separators', () => {
    expect(toRepoRelativePath('D:\\a\\slicc\\packages\\node-server\\tests\\b.test.ts')).toBe(
      'packages/node-server/tests/b.test.ts'
    );
  });
  it('passes an already-relative path through', () => {
    expect(toRepoRelativePath('packages/shared-ts/tests/c.test.ts')).toBe(
      'packages/shared-ts/tests/c.test.ts'
    );
  });
  it('tolerates missing input', () => {
    expect(toRepoRelativePath(null)).toBe('');
    expect(toRepoRelativePath(undefined)).toBe('');
  });
});

describe('inferProject', () => {
  it('derives the vitest project from the package directory', () => {
    expect(inferProject('/x/packages/chrome-extension/tests/a.test.ts')).toBe('chrome-extension');
    expect(inferProject('packages/node-server/tests/a.test.ts')).toBe('node-server');
  });
  it('maps shared-ts to the `shared` project name', () => {
    expect(inferProject('packages/shared-ts/tests/base64.test.ts')).toBe('shared');
  });
  it('falls back to unknown outside packages/', () => {
    expect(inferProject('scripts/foo.test.ts')).toBe('unknown');
  });
});

describe('normalizeTestName', () => {
  it('collapses the two suite separators to one canonical form', () => {
    expect(normalizeTestName('suite > nested > test')).toBe(normalizeTestName('suite nested test'));
  });
  it('collapses redundant whitespace and tolerates missing input', () => {
    expect(normalizeTestName('  a   b  ')).toBe('a b');
    expect(normalizeTestName(undefined)).toBe('');
  });
});

describe('fingerprint', () => {
  it('is stable and independent of the absolute checkout path', () => {
    const a = fingerprint({
      project: 'webapp',
      file: '/home/runner/work/slicc/slicc/packages/webapp/tests/a.test.ts',
      testName: 'x y',
    });
    const b = fingerprint({
      project: 'webapp',
      file: 'packages/webapp/tests/a.test.ts',
      testName: 'x y',
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
  });
  it('matches across the two artifact shapes for the same test', () => {
    const fromJson = extractFlakesFromVitestJson(VITEST_JSON)[0];
    const fromLedger = extractFlakesFromLedger(LEDGER_JSON)[0];
    expect(fromJson.fingerprint).toBe(fromLedger.fingerprint);
  });
  it('separates different tests and different projects', () => {
    const base = { project: 'webapp', file: 'packages/webapp/tests/a.test.ts', testName: 'x' };
    expect(fingerprint(base)).not.toBe(fingerprint({ ...base, testName: 'y' }));
    expect(fingerprint(base)).not.toBe(fingerprint({ ...base, project: 'cherry' }));
  });
});

describe('extractFlakesFromVitestJson', () => {
  it('flags a test that passed but still carries a failed attempt', () => {
    const flakes = extractFlakesFromVitestJson(VITEST_JSON);
    expect(flakes).toHaveLength(1);
    expect(flakes[0]).toMatchObject({
      project: 'chrome-extension',
      file: 'packages/chrome-extension/tests/probe.test.ts',
      testName: 'flake probe passes only on the second attempt',
      attempts: 2,
      source: 'vitest-json',
    });
    expect(flakes[0].failureMessage).toBe(
      'AssertionError: probe attempt 1 is deliberately failing: expected 1 to be greater than 1'
    );
  });

  it('does NOT flag a test that failed every attempt — that is a real failure', () => {
    const names = extractFlakesFromVitestJson(VITEST_JSON).map((f) => f.testName);
    expect(names).not.toContain('flake probe fails on every attempt');
  });

  it('does NOT flag a clean pass or an expected failure', () => {
    const names = extractFlakesFromVitestJson(VITEST_JSON).map((f) => f.testName);
    expect(names).not.toContain('flake probe passes first try');
    expect(names).not.toContain('flake probe is an expected failure');
  });

  it('counts each recorded failure as an attempt', () => {
    const report = {
      testResults: [
        {
          name: 'packages/node-server/tests/a.test.ts',
          assertionResults: [
            {
              fullName: 'flaked twice',
              status: 'passed',
              failureMessages: ['first boom', 'second boom'],
            },
          ],
        },
      ],
    };
    expect(extractFlakesFromVitestJson(report)[0].attempts).toBe(3);
  });

  it('honours a project override from the artifact name', () => {
    expect(extractFlakesFromVitestJson(VITEST_JSON, { project: 'weird' })[0].project).toBe('weird');
  });

  it('tolerates empty, malformed, and missing structures', () => {
    expect(extractFlakesFromVitestJson(undefined)).toEqual([]);
    expect(extractFlakesFromVitestJson({})).toEqual([]);
    expect(extractFlakesFromVitestJson({ testResults: [{}, null] })).toEqual([]);
    expect(
      extractFlakesFromVitestJson({
        testResults: [
          { name: 'a', assertionResults: [{ status: 'passed', failureMessages: null }] },
        ],
      })
    ).toEqual([]);
  });
});

describe('extractFlakesFromLedger', () => {
  it('uses the exact retryCount to derive attempts', () => {
    const flakes = extractFlakesFromLedger(LEDGER_JSON);
    expect(flakes).toHaveLength(1);
    expect(flakes[0]).toMatchObject({
      project: 'chrome-extension',
      attempts: 2,
      source: 'flake-reporter',
      testName: 'flake probe > passes only on the second attempt',
    });
  });
  it('never reports fewer than two attempts', () => {
    const flakes = extractFlakesFromLedger({ flakes: [{ file: 'packages/x/tests/a.test.ts' }] });
    expect(flakes[0].attempts).toBe(2);
  });
  it('tolerates empty and missing structures', () => {
    expect(extractFlakesFromLedger(undefined)).toEqual([]);
    expect(extractFlakesFromLedger({ flakes: [] })).toEqual([]);
  });
});

describe('parseReport', () => {
  it('dispatches on the artifact shape', () => {
    expect(parseReport(JSON.stringify(LEDGER_JSON))[0].source).toBe('flake-reporter');
    expect(parseReport(JSON.stringify(VITEST_JSON))[0].source).toBe('vitest-json');
  });
  it('returns [] for a missing, empty, or unparseable artifact', () => {
    expect(parseReport(null)).toEqual([]);
    expect(parseReport(undefined)).toEqual([]);
    expect(parseReport('')).toEqual([]);
    expect(parseReport('   ')).toEqual([]);
    expect(parseReport('{"truncated":')).toEqual([]);
    expect(parseReport('[]')).toEqual([]);
    expect(parseReport('{"kind":"something-else"}')).toEqual([]);
  });
});

describe('aggregateFlakes', () => {
  it('merges the two shapes from one run into a single flake counted once', () => {
    const flakes = aggregateFlakes([
      { text: JSON.stringify(VITEST_JSON), runId: 111 },
      { text: JSON.stringify(LEDGER_JSON), runId: 111 },
    ]);
    expect(flakes).toHaveLength(1);
    expect(flakes[0].occurrences).toBe(1);
    expect(flakes[0].runs).toBe(1);
    // The reporter record is exact, so its provenance and name win.
    expect(flakes[0].source).toBe('flake-reporter');
    expect(flakes[0].testName).toContain(' > ');
  });

  it('counts distinct runs and keeps the highest attempt count', () => {
    const flakes = aggregateFlakes([
      { text: JSON.stringify(VITEST_JSON), runId: 1 },
      { text: JSON.stringify(VITEST_JSON), runId: 2 },
      { text: JSON.stringify(LEDGER_JSON), runId: 3 },
    ]);
    expect(flakes[0].occurrences).toBe(3);
    expect(flakes[0].runs).toBe(3);
    expect(flakes[0].runIds).toEqual(['1', '2', '3']);
    expect(flakes[0].maxAttempts).toBe(2);
  });

  it('keeps flakes from different projects apart and sorts by frequency', () => {
    const other = {
      kind: LEDGER_KIND,
      flakes: [
        {
          project: 'node-server',
          file: 'packages/node-server/tests/port.test.ts',
          testName: 'binds a free port',
          retryCount: 1,
        },
      ],
    };
    const flakes = aggregateFlakes([
      { text: JSON.stringify(other), runId: 1 },
      { text: JSON.stringify(other), runId: 2 },
      { text: JSON.stringify(LEDGER_JSON), runId: 1 },
    ]);
    expect(flakes).toHaveLength(2);
    expect(flakes[0].project).toBe('node-server');
    expect(flakes[0].occurrences).toBe(2);
    expect(flakes[1].project).toBe('chrome-extension');
  });

  it('skips artifacts that could not be downloaded without losing the rest', () => {
    const flakes = aggregateFlakes([
      { text: null, runId: 1 },
      { text: '{truncated', runId: 2 },
      { text: JSON.stringify(LEDGER_JSON), runId: 3 },
    ]);
    expect(flakes).toHaveLength(1);
    expect(flakes[0].runs).toBe(1);
  });

  it('never reports a test that failed every attempt', () => {
    const allFailed = {
      testResults: [
        {
          name: 'packages/webapp/tests/a.test.ts',
          assertionResults: [
            { fullName: 'always broken', status: 'failed', failureMessages: ['boom', 'boom'] },
          ],
        },
      ],
    };
    expect(aggregateFlakes([{ text: JSON.stringify(allFailed), runId: 1 }])).toEqual([]);
  });

  it('returns [] for empty or missing input', () => {
    expect(aggregateFlakes([])).toEqual([]);
    expect(aggregateFlakes(undefined)).toEqual([]);
    expect(aggregateFlakes([{}])).toEqual([]);
  });

  it('counts every sighting when no run id is available (local use)', () => {
    const flakes = aggregateFlakes([
      { text: JSON.stringify(LEDGER_JSON) },
      { text: JSON.stringify(LEDGER_JSON) },
    ]);
    expect(flakes[0].occurrences).toBe(2);
    expect(flakes[0].runs).toBe(0);
  });
});

describe('parseFingerprints', () => {
  it('maps markers to issue numbers, case-insensitively', () => {
    const filed = parseFingerprints([
      { number: 12, state: 'OPEN', body: 'text\n<!-- flake-fp:abc123abc123 -->' },
      { number: 13, state: 'CLOSED', body: 'FLAKE-FP: DEF456DEF456' },
      { number: 14, state: 'OPEN', body: 'no marker' },
    ]);
    expect(filed.get('abc123abc123')).toEqual({ number: 12, state: 'OPEN' });
    expect(filed.get('def456def456')).toEqual({ number: 13, state: 'CLOSED' });
    expect(filed.size).toBe(2);
  });

  it('prefers an open issue over a closed one for the same flake', () => {
    const filed = parseFingerprints([
      { number: 1, state: 'OPEN', body: '<!-- flake-fp:aaaaaaaaaaaa -->' },
      { number: 2, state: 'CLOSED', body: '<!-- flake-fp:aaaaaaaaaaaa -->' },
    ]);
    expect(filed.get('aaaaaaaaaaaa').number).toBe(1);
  });

  it('tolerates empty and missing input', () => {
    expect(parseFingerprints([]).size).toBe(0);
    expect(parseFingerprints(undefined).size).toBe(0);
    expect(parseFingerprints([{}]).size).toBe(0);
  });
});

describe('partitionFlakes', () => {
  const flakes = aggregateFlakes([{ text: JSON.stringify(LEDGER_JSON), runId: 1 }]);

  it('routes an already-filed flake to its existing issue instead of a new one', () => {
    const filed = new Map([[flakes[0].fingerprint, { number: 42, state: 'CLOSED' }]]);
    const { fresh, recurring } = partitionFlakes(flakes, filed);
    expect(fresh).toEqual([]);
    expect(recurring).toHaveLength(1);
    expect(recurring[0].issue).toBe(42);
    expect(recurring[0].issueState).toBe('CLOSED');
  });

  it('treats an unseen flake as fresh', () => {
    expect(partitionFlakes(flakes, new Map()).fresh).toHaveLength(1);
    expect(partitionFlakes(flakes, undefined).fresh).toHaveLength(1);
    expect(partitionFlakes(undefined, new Map()).fresh).toEqual([]);
  });
});

describe('issue rendering', () => {
  const flake = aggregateFlakes([
    { text: JSON.stringify(VITEST_JSON), runId: 111 },
    { text: JSON.stringify(LEDGER_JSON), runId: 111 },
  ])[0];

  it('titles the issue by project and test, without volatile counts', () => {
    const title = renderIssueTitle(flake);
    expect(title).toBe('flake: [chrome-extension] flake probe > passes only on the second attempt');
    expect(title).not.toMatch(/\d+ run/);
  });

  it('falls back to the file when a test name is missing', () => {
    expect(renderIssueTitle({ project: 'webapp', file: 'packages/webapp/tests/a.test.ts' })).toBe(
      'flake: [webapp] packages/webapp/tests/a.test.ts'
    );
    expect(renderIssueTitle({})).toBe('flake: [unknown] unknown test');
  });

  it('embeds the dedup marker, the failure, and a reproduction command', () => {
    const body = renderIssueBody(flake, {
      window: 'last 2 days',
      repoUrl: 'https://github.com/ai-ecoverse/slicc',
    });
    expect(body).toContain(`<!-- flake-fp:${flake.fingerprint} -->`);
    expect(body).toContain('packages/chrome-extension/tests/probe.test.ts');
    expect(body).toContain('deliberately failing');
    expect(body).toContain('npx vitest run --project chrome-extension --retry=0');
    expect(body).toContain('https://github.com/ai-ecoverse/slicc/actions/runs/111');
    expect(body).toContain('last 2 days');
    expect(parseFingerprints([{ number: 1, state: 'OPEN', body }]).has(flake.fingerprint)).toBe(
      true
    );
  });

  it('omits the failure block and run links when there is nothing to show', () => {
    const body = renderIssueBody({
      project: 'webapp',
      file: 'packages/webapp/tests/a.test.ts',
      testName: 'x',
      attempts: 2,
      fingerprint: 'ffffffffffff',
    });
    expect(body).not.toContain('Failure from the losing attempt');
    expect(body).not.toContain('Runs:');
  });

  it('renders a recurrence comment carrying the same marker', () => {
    const comment = renderRecurrenceComment(flake, { window: 'in the last day' });
    expect(comment).toContain('Still flaking');
    expect(comment).toContain('in the last day');
    expect(comment).toContain(`<!-- flake-fp:${flake.fingerprint} -->`);
  });
});

describe('FLAKE_LABEL', () => {
  it('stays inside the existing debt: namespace', () => {
    expect(FLAKE_LABEL).toBe('debt:flake');
  });
});
