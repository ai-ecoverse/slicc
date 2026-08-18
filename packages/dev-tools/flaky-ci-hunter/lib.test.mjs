import { describe, expect, it } from 'vitest';
import {
  attemptsFromPulls,
  buildDigest,
  buildPrompt,
  CONFIG,
  createdRangeParam,
  dayWindows,
  dedupeFlips,
  extractFailureLines,
  filterCandidates,
  findAttemptFlips,
  findMainRegressionFlips,
  fixBranch,
  isDefaultBranchRef,
  isExcludedJob,
  jobSlug,
  localizeFlake,
  matchMitigatedInfra,
  scoreCandidates,
  slugFromBranch,
  windowStart,
  withinWindow,
} from './lib.mjs';
import { scan } from './scan-flakes.mjs';

/* ───────────────────── the 1000-item-cap workaround ───────────────────── */

describe('dayWindows', () => {
  // Every UTC day the trailing window TOUCHES is queried — `windowDays + 1`
  // dates for any `now` that is not exactly midnight. Counting calendar dates
  // alone used to under-cover: at the Monday 06:50 cron, seven dates spanned
  // Tuesday 00:00 → Monday 06:50 (~6d 7h), silently dropping the previous
  // Monday morning and with it enough flips to fall under the threshold.
  it('covers every day the trailing window touches, oldest first', () => {
    const days = dayWindows(new Date('2025-03-20T11:30:00Z'), CONFIG.WINDOW_DAYS);
    expect(days).toEqual([
      '2025-03-13',
      '2025-03-14',
      '2025-03-15',
      '2025-03-16',
      '2025-03-17',
      '2025-03-18',
      '2025-03-19',
      '2025-03-20',
    ]);
  });

  it('reaches back a full 7 days at the Monday 06:50 cron slot', () => {
    // The regression this guards: the previous Monday must be in the listing.
    const days = dayWindows(new Date('2025-03-17T06:50:00Z'), 7);
    expect(days[0]).toBe('2025-03-10');
    expect(days.at(-1)).toBe('2025-03-17');
    expect(windowStart(new Date('2025-03-17T06:50:00Z'), 7).toISOString()).toBe(
      '2025-03-10T06:50:00.000Z'
    );
  });

  it('walks back across a month boundary (and a short month)', () => {
    expect(dayWindows(new Date('2025-03-02T00:00:01Z'), 4)).toEqual([
      '2025-02-26',
      '2025-02-27',
      '2025-02-28',
      '2025-03-01',
      '2025-03-02',
    ]);
  });

  it('walks back across a year boundary', () => {
    expect(dayWindows(new Date('2025-01-02T23:59:59Z'), 4)).toEqual([
      '2024-12-29',
      '2024-12-30',
      '2024-12-31',
      '2025-01-01',
      '2025-01-02',
    ]);
  });

  it('walks back across a leap day', () => {
    expect(dayWindows(new Date('2024-03-01T00:00:00Z'), 3)).toEqual([
      '2024-02-27',
      '2024-02-28',
      '2024-02-29',
      '2024-03-01',
    ]);
  });

  it('never returns zero days and falls back to the default on junk window sizes', () => {
    expect(dayWindows(new Date('2025-05-05T00:00:00Z'), 1)).toEqual(['2025-05-04', '2025-05-05']);
    expect(dayWindows(new Date('2025-05-05T00:00:00Z'), 0)).toHaveLength(CONFIG.WINDOW_DAYS + 1);
    expect(dayWindows('2025-05-05T00:00:00Z', Number.NaN)).toHaveLength(CONFIG.WINDOW_DAYS + 1);
  });

  it('trims the boundary day back to the exact window start', () => {
    const now = new Date('2025-03-17T06:50:00Z');
    const cutoff = windowStart(now, 7);
    const runs = [
      { id: 1, created_at: '2025-03-10T05:00:00Z' }, // before the window opens
      { id: 2, created_at: '2025-03-10T06:50:00Z' }, // exactly at the boundary
      { id: 3, created_at: '2025-03-14T00:00:00Z' },
    ];
    expect(withinWindow(runs, cutoff).map((r) => r.id)).toEqual([2, 3]);
  });

  it('keeps a run whose timestamp cannot be parsed', () => {
    // Losing evidence to a bad timestamp is worse than scanning a little extra.
    const kept = withinWindow([{ id: 9, created_at: 'not-a-date' }, { id: 10 }], new Date());
    expect(kept.map((r) => r.id)).toEqual([9, 10]);
  });

  it('pins each query to a single closed day range', () => {
    expect(createdRangeParam('2025-03-14')).toBe('created=2025-03-14..2025-03-14');
  });
});

/* ─────────────────────────── source 1: attempts ─────────────────────────── */

const attemptMeta = {
  workflow: 'CI',
  headSha: 'abc1234567890',
  runUrl: 'https://gh/run/1',
  runId: 1,
};

describe('findAttemptFlips', () => {
  it('counts failure on an early attempt then success on a later one', () => {
    const flips = findAttemptFlips(
      {
        1: [{ name: 'node-server', conclusion: 'failure', id: 11 }],
        2: [{ name: 'node-server', conclusion: 'success', id: 12 }],
      },
      attemptMeta
    );
    expect(flips).toHaveLength(1);
    expect(flips[0]).toMatchObject({
      workflow: 'CI',
      job: 'node-server',
      headSha: 'abc1234567890',
      source: 'attempt',
      // The FAILING attempt's job id is what Step 3 reads logs from.
      jobId: 11,
      successJobId: 12,
    });
    expect(flips[0].detail).toContain('attempt 1 failure → attempt 2 success');
  });

  it('does not count failure then failure — that is a broken job, not a flake', () => {
    const flips = findAttemptFlips(
      {
        1: [{ name: 'lint', conclusion: 'failure' }],
        2: [{ name: 'lint', conclusion: 'failure' }],
      },
      attemptMeta
    );
    expect(flips).toEqual([]);
  });

  it('does not count success then success', () => {
    const flips = findAttemptFlips(
      {
        1: [{ name: 'lint', conclusion: 'success' }],
        2: [{ name: 'lint', conclusion: 'success' }],
      },
      attemptMeta
    );
    expect(flips).toEqual([]);
  });

  it('does not count a success followed by a later failure', () => {
    const flips = findAttemptFlips(
      {
        1: [{ name: 'lint', conclusion: 'success' }],
        2: [{ name: 'lint', conclusion: 'failure' }],
      },
      attemptMeta
    );
    expect(flips).toEqual([]);
  });

  it('counts timed_out then success, and only once per job even across three attempts', () => {
    const flips = findAttemptFlips(
      {
        1: [{ name: 'e2e', conclusion: 'timed_out', id: 1 }],
        2: [{ name: 'e2e', conclusion: 'success', id: 2 }],
        3: [{ name: 'e2e', conclusion: 'success', id: 3 }],
      },
      attemptMeta
    );
    expect(flips).toHaveLength(1);
    expect(flips[0].detail).toContain('timed_out');
  });

  it('ignores unnamed jobs, skipped/cancelled conclusions, and empty input', () => {
    expect(findAttemptFlips({}, attemptMeta)).toEqual([]);
    expect(findAttemptFlips(undefined, attemptMeta)).toEqual([]);
    expect(
      findAttemptFlips(
        {
          1: [{ conclusion: 'failure' }, { name: 'x', conclusion: 'skipped' }],
          2: [{ name: 'x', conclusion: 'cancelled' }],
        },
        attemptMeta
      )
    ).toEqual([]);
  });
});

/* ─────────────────── source 3: green-then-red on main ─────────────────── */

const mainObservations = [
  {
    workflow: 'CI',
    job: 'webapp',
    headSha: 'deadbeefcafe',
    conclusion: 'success',
    event: 'pull_request',
    branch: 'feature',
    runUrl: 'https://gh/run/pr',
  },
  {
    workflow: 'CI',
    job: 'webapp',
    headSha: 'deadbeefcafe',
    conclusion: 'failure',
    event: 'push',
    branch: 'main',
    runUrl: 'https://gh/run/main',
  },
];

describe('findMainRegressionFlips', () => {
  it('requires corroboration from source 1 before counting a main regression', () => {
    expect(findMainRegressionFlips({ observations: mainObservations })).toEqual([]);
    const flips = findMainRegressionFlips({
      observations: mainObservations,
      corroboratedJobs: new Set(['CI\u0000webapp']),
    });
    expect(flips).toHaveLength(1);
    expect(flips[0]).toMatchObject({ job: 'webapp', source: 'main-regression' });
    expect(flips[0].detail).toContain('post-merge on main');
  });

  it('counts a merge-queue failure, whose head_branch is the queue ref', () => {
    // `merge_group` runs never carry the branch name — the merge queue puts
    // `gh-readonly-queue/main/pr-123-<sha>` in head_branch. A literal
    // `=== 'main'` comparison dropped every merge-queue run, which in this repo
    // is most post-merge CI, so source 3 was quietly dead.
    const observations = [
      mainObservations[0],
      {
        ...mainObservations[1],
        event: 'merge_group',
        branch: 'gh-readonly-queue/main/pr-2163-abc1234',
      },
    ];
    const flips = findMainRegressionFlips({
      observations,
      corroboratedJobs: new Set(['CI\u0000webapp']),
    });
    expect(flips).toHaveLength(1);
    expect(flips[0]).toMatchObject({ job: 'webapp', source: 'main-regression' });
  });

  it('recognises the default branch by name or by its merge-queue ref', () => {
    expect(isDefaultBranchRef('main')).toBe(true);
    expect(isDefaultBranchRef('gh-readonly-queue/main/pr-1-abc')).toBe(true);
    expect(isDefaultBranchRef('release/1.x')).toBe(false);
    expect(isDefaultBranchRef('gh-readonly-queue/release/pr-1-abc')).toBe(false);
    expect(isDefaultBranchRef(null)).toBe(true); // not stated; the event gate already narrowed it
  });

  it('needs both halves of the pair (green on the PR head AND red post-merge)', () => {
    const corroboratedJobs = new Set(['CI\u0000webapp']);
    expect(
      findMainRegressionFlips({ observations: [mainObservations[0]], corroboratedJobs })
    ).toEqual([]);
    expect(
      findMainRegressionFlips({ observations: [mainObservations[1]], corroboratedJobs })
    ).toEqual([]);
  });

  it('ignores failures on a non-default branch and malformed observations', () => {
    const observations = [
      mainObservations[0],
      { ...mainObservations[1], branch: 'release/1.x' },
      { job: 'no-workflow', headSha: 'x' },
    ];
    expect(
      findMainRegressionFlips({ observations, corroboratedJobs: new Set(['CI\u0000webapp']) })
    ).toEqual([]);
  });
});

/* ───────────────────────── dedup + distinct-commit score ───────────────────────── */

describe('dedupeFlips', () => {
  it('collapses the same (workflow, job, sha) seen twice and keeps the stronger source', () => {
    const flips = dedupeFlips([
      { workflow: 'CI', job: 'webapp', headSha: 'aaa', source: 'main-regression' },
      { workflow: 'CI', job: 'webapp', headSha: 'aaa', source: 'attempt' },
    ]);
    expect(flips).toHaveLength(1);
    expect(flips[0].source).toBe('attempt');
  });

  it('keeps flips that differ in sha or job, and drops malformed entries', () => {
    expect(
      dedupeFlips([
        { workflow: 'CI', job: 'webapp', headSha: 'aaa', source: 'attempt' },
        { workflow: 'CI', job: 'webapp', headSha: 'bbb', source: 'attempt' },
        { workflow: 'CI', job: 'e2e', headSha: 'aaa', source: 'attempt' },
        { workflow: 'CI', headSha: 'aaa', source: 'attempt' },
      ])
    ).toHaveLength(3);
  });
});

describe('scoreCandidates', () => {
  it('scores DISTINCT commits — two flips on one sha score 1, not 2', () => {
    const [candidate] = scoreCandidates([
      { workflow: 'CI', job: 'node-server', headSha: 'aaa', source: 'attempt' },
      { workflow: 'CI', job: 'node-server', headSha: 'aaa', source: 'main-regression' },
    ]);
    expect(candidate.flakeScore).toBe(1);
    expect(candidate.sources).toEqual(['attempt']);
  });

  it('groups by (workflow, job) and sorts the worst offender first', () => {
    const candidates = scoreCandidates([
      { workflow: 'CI', job: 'quiet', headSha: 'aaa', source: 'attempt' },
      { workflow: 'CI', job: 'noisy', headSha: 'aaa', source: 'attempt' },
      { workflow: 'CI', job: 'noisy', headSha: 'bbb', source: 'attempt' },
      { workflow: 'CI', job: 'noisy', headSha: 'ccc', source: 'attempt' },
    ]);
    expect(candidates.map((c) => [c.job, c.flakeScore])).toEqual([
      ['noisy', 3],
      ['quiet', 1],
    ]);
    expect(candidates[0].slug).toBe('ci--noisy');
  });
});

/* ───────────────────────── slugs = the durable registry ───────────────────────── */

describe('jobSlug', () => {
  it('round-trips a job name with spaces, slashes, and parentheses through a branch', () => {
    const slug = jobSlug('CI', 'slicc-cli (ubuntu-latest) / build & test');
    expect(slug).toBe('ci--slicc-cli-ubuntu-latest-build-test');
    const branch = fixBranch(slug);
    expect(branch).toBe('automation/flaky-fix/ci--slicc-cli-ubuntu-latest-build-test');
    expect(slugFromBranch(branch)).toBe(slug);
    expect(slugFromBranch(`refs/heads/${branch}`)).toBe(slug);
  });

  it('produces branch-safe slugs with no leading/trailing dashes or slashes', () => {
    const slug = jobSlug('  Worker / Staging  ', '(e2e) — swift-server ');
    expect(slug).toMatch(/^[a-z0-9]+(-{1,2}[a-z0-9]+)*$/);
    expect(slugFromBranch(fixBranch(slug))).toBe(slug);
  });

  it('never returns an empty slug', () => {
    expect(jobSlug('', '')).toBe('unknown');
    expect(jobSlug(null, undefined)).toBe('unknown');
  });

  it('rejects branches that are not ours', () => {
    expect(slugFromBranch('main')).toBeNull();
    expect(slugFromBranch('automation/coverage-ratchet')).toBeNull();
    expect(slugFromBranch('automation/flaky-fix/')).toBeNull();
    expect(slugFromBranch(undefined)).toBeNull();
  });
});

/* ───────────────────────── Step 4: filters ───────────────────────── */

describe('isExcludedJob', () => {
  it('excludes release / publish / deploy jobs and whole release workflows', () => {
    expect(isExcludedJob({ workflow: 'CI', job: 'release-gate' })).toBe(true);
    expect(isExcludedJob({ workflow: 'Release', job: 'analyze' })).toBe(true);
    expect(isExcludedJob({ workflow: 'Worker Production Deploy', job: 'deploy-production' })).toBe(
      true
    );
    expect(isExcludedJob({ workflow: 'Worker Staging Deploy', job: 'deploy-staging' })).toBe(true);
    expect(isExcludedJob({ workflow: 'CI', job: 'publish-extension' })).toBe(true);
  });

  it('does not exclude ordinary test jobs', () => {
    expect(isExcludedJob({ workflow: 'CI', job: 'node-server' })).toBe(false);
    expect(isExcludedJob({ workflow: 'CI', job: 'e2e' })).toBe(false);
    expect(isExcludedJob()).toBe(false);
  });
});

describe('matchMitigatedInfra', () => {
  it('matches the npm-registry IPv6 flake already mitigated in ci.yml', () => {
    const hit = matchMitigatedInfra(
      'npm ERR! network request to https://registry.npmjs.org/vitest failed, reason: ETIMEDOUT'
    );
    expect(hit?.id).toBe('npm-registry-ipv6');
    expect(hit?.note).toContain('--dns-result-order=ipv4first');
  });

  it('matches artifact transport failures and runner outages', () => {
    expect(
      matchMitigatedInfra('Error: actions/cache failed: getaddrinfo ENOTFOUND blob.core')?.id
    ).toBe('artifact-transport');
    expect(matchMitigatedInfra('The runner has received a shutdown signal.')?.id).toBe(
      'runner-outage'
    );
  });

  it('returns null for a genuine in-repo failure', () => {
    expect(matchMitigatedInfra('AssertionError: expected 2 to be 3')).toBeNull();
    expect(matchMitigatedInfra('')).toBeNull();
    expect(matchMitigatedInfra(undefined)).toBeNull();
  });
});

const NOW = new Date('2025-06-10T06:50:00Z');

/** A candidate that passes every gate except whatever a test overrides. */
function candidate(overrides = {}) {
  return {
    workflow: 'CI',
    job: 'node-server',
    slug: jobSlug('CI', 'node-server'),
    flakeScore: 3,
    sources: ['attempt'],
    flips: [
      { headSha: 'aaaaaaaa11', detail: 'attempt 1 failure → attempt 2 success', runUrl: 'u1' },
      { headSha: 'bbbbbbbb22', detail: 'attempt 1 failure → attempt 2 success', runUrl: 'u2' },
    ],
    localized: true,
    signature: 'FAIL tests/spawn.test.ts > binds a port',
    ...overrides,
  };
}

describe('filterCandidates', () => {
  it('dispatches the worst localized offender and gives a reason', () => {
    const { dispatch, decisions } = filterCandidates({ candidates: [candidate()], now: NOW });
    expect(dispatch).toHaveLength(1);
    expect(decisions[0].action).toBe('dispatch');
    expect(decisions[0].reason).toContain('3 distinct commits');
  });

  it('cuts candidates below FLAKE_THRESHOLD — one flip is noise', () => {
    const { dispatch, decisions } = filterCandidates({
      candidates: [candidate({ flakeScore: 1 })],
      now: NOW,
    });
    expect(dispatch).toEqual([]);
    expect(decisions[0].action).toBe('below-threshold');
    expect(decisions[0].reason).toContain('threshold is 2');
  });

  it('honours an overridden threshold', () => {
    expect(
      filterCandidates({ candidates: [candidate({ flakeScore: 2 })], threshold: 3, now: NOW })
        .decisions[0].action
    ).toBe('below-threshold');
  });

  it('drops release/publish/deploy jobs before anything else', () => {
    const { decisions } = filterCandidates({
      candidates: [candidate({ job: 'release-gate', flakeScore: 9 })],
      now: NOW,
    });
    expect(decisions[0].action).toBe('excluded');
    expect(decisions[0].reason).toContain('human conversation');
  });

  it('drops a candidate fully explained by known mitigated infrastructure', () => {
    const { dispatch, decisions } = filterCandidates({
      candidates: [
        candidate({
          mitigatedInfra: { id: 'npm-registry-ipv6', label: 'npm registry', note: 'already fixed' },
        }),
      ],
      now: NOW,
    });
    expect(dispatch).toEqual([]);
    expect(decisions[0].action).toBe('infra');
  });

  it('defers a candidate whose flips have nothing in common', () => {
    const { decisions } = filterCandidates({
      candidates: [candidate({ localized: false, localizationReason: 'no shared failure line' })],
      now: NOW,
    });
    expect(decisions[0].action).toBe('unlocalized');
    expect(decisions[0].reason).toBe('no shared failure line');
  });

  it('respects MAX_DISPATCHES_PER_RUN — one fixer a week, no more', () => {
    const { dispatch, decisions } = filterCandidates({
      candidates: [candidate(), candidate({ job: 'e2e', slug: jobSlug('CI', 'e2e') })],
      now: NOW,
    });
    expect(dispatch).toHaveLength(1);
    expect(decisions[1].action).toBe('budget-spent');
  });

  describe('GitHub-native cooldown and attempt tracking', () => {
    const slug = jobSlug('CI', 'node-server');

    it('holds off inside COOLDOWN_DAYS when no fix has merged', () => {
      const attemptsByJob = attemptsFromPulls([
        {
          number: 7,
          state: 'closed',
          created_at: '2025-06-01T00:00:00Z',
          merged_at: null,
          head: { ref: `automation/flaky-fix/${slug}` },
        },
      ]);
      const { dispatch, decisions } = filterCandidates({
        candidates: [candidate()],
        attemptsByJob,
        now: NOW,
      });
      expect(dispatch).toEqual([]);
      expect(decisions[0].action).toBe('cooldown');
      expect(decisions[0].reason).toContain('COOLDOWN_DAYS=21');
    });

    it('lifts the cooldown once a fix PR merged', () => {
      const attemptsByJob = attemptsFromPulls([
        {
          number: 7,
          state: 'closed',
          created_at: '2025-06-01T00:00:00Z',
          merged_at: '2025-06-02T00:00:00Z',
          head: { ref: `automation/flaky-fix/${slug}` },
        },
      ]);
      expect(
        filterCandidates({ candidates: [candidate()], attemptsByJob, now: NOW }).decisions[0].action
      ).toBe('dispatch');
    });

    it('lifts the cooldown once COOLDOWN_DAYS have passed', () => {
      const attemptsByJob = attemptsFromPulls([
        {
          number: 7,
          state: 'closed',
          created_at: '2025-04-01T00:00:00Z',
          merged_at: null,
          head: { ref: `automation/flaky-fix/${slug}` },
        },
      ]);
      expect(
        filterCandidates({ candidates: [candidate()], attemptsByJob, now: NOW }).decisions[0].action
      ).toBe('dispatch');
    });

    it('gives up after MAX_ATTEMPTS_PER_JOB dispatches and leaves it for a human', () => {
      const attemptsByJob = attemptsFromPulls([
        {
          state: 'closed',
          created_at: '2024-01-01T00:00:00Z',
          merged_at: '2024-01-02T00:00:00Z',
          head: { ref: `automation/flaky-fix/${slug}` },
        },
        {
          state: 'closed',
          created_at: '2024-02-01T00:00:00Z',
          merged_at: '2024-02-02T00:00:00Z',
          head: { ref: `automation/flaky-fix/${slug}` },
        },
      ]);
      expect(attemptsByJob[slug].attempts).toBe(CONFIG.MAX_ATTEMPTS_PER_JOB);
      const { decisions } = filterCandidates({
        candidates: [candidate()],
        attemptsByJob,
        now: NOW,
      });
      expect(decisions[0].action).toBe('gave-up');
      expect(decisions[0].reason).toContain('automation/flaky-fix/ci--node-server');
    });

    it('skips a job whose fix PR is still open', () => {
      const attemptsByJob = attemptsFromPulls([
        {
          state: 'open',
          created_at: '2025-06-09T00:00:00Z',
          merged_at: null,
          html_url: 'https://gh/pr/9',
          head: { ref: `automation/flaky-fix/${slug}` },
        },
      ]);
      const { decisions } = filterCandidates({
        candidates: [candidate()],
        attemptsByJob,
        now: NOW,
      });
      expect(decisions[0].action).toBe('in-flight');
      expect(decisions[0].reason).toContain('https://gh/pr/9');
    });
  });
});

describe('attemptsFromPulls', () => {
  it('ignores pull requests from branches outside the registry prefix', () => {
    expect(
      attemptsFromPulls([
        { state: 'open', created_at: '2025-01-01T00:00:00Z', head: { ref: 'feature/x' } },
        { state: 'open', created_at: '2025-01-01T00:00:00Z' },
      ])
    ).toEqual({});
  });

  it('keeps the latest dispatch and merge dates per slug', () => {
    const out = attemptsFromPulls([
      {
        state: 'closed',
        created_at: '2025-01-01T00:00:00Z',
        merged_at: '2025-01-02T00:00:00Z',
        head: { ref: 'automation/flaky-fix/ci--e2e' },
      },
      {
        state: 'closed',
        created_at: '2025-03-01T00:00:00Z',
        merged_at: null,
        head: { ref: 'automation/flaky-fix/ci--e2e' },
      },
    ]);
    expect(out['ci--e2e']).toEqual({
      attempts: 2,
      lastDispatchAt: '2025-03-01T00:00:00Z',
      lastMergedAt: '2025-01-02T00:00:00Z',
      openPrUrl: null,
    });
  });
});

/* ───────────────────────── Step 3: localization ───────────────────────── */

describe('extractFailureLines / localizeFlake', () => {
  it('strips ANSI and Actions timestamps and keeps only failure-ish lines', () => {
    const log = [
      '2025-06-10T06:50:00.1234567Z Running tests',
      '2025-06-10T06:50:01.1234567Z \u001B[31mFAIL\u001B[0m tests/spawn.test.ts > binds a port',
      '2025-06-10T06:50:01.1234567Z all good here',
      '2025-06-10T06:50:02.1234567Z Error: EADDRINUSE 5710',
    ].join('\n');
    expect(extractFailureLines(log)).toEqual([
      'FAIL tests/spawn.test.ts > binds a port',
      'Error: EADDRINUSE 5710',
    ]);
  });

  it('localizes two flips that share a failure line, ignoring volatile numbers', () => {
    const out = localizeFlake([
      { runUrl: 'u1', lines: ['FAIL tests/spawn.test.ts > binds a port', 'took 1200 ms'] },
      { runUrl: 'u2', lines: ['FAIL tests/spawn.test.ts > binds a port', 'took 90 ms'] },
    ]);
    expect(out.localized).toBe(true);
    expect(out.signature).toContain('binds a port');
  });

  it('refuses to localize when two flips have nothing in common', () => {
    const out = localizeFlake([
      { lines: ['FAIL tests/a.test.ts > alpha'] },
      { lines: ['FAIL tests/b.test.ts > beta'] },
    ]);
    expect(out.localized).toBe(false);
    expect(out.reason).toContain('nothing in common');
  });

  it('refuses to localize a gate job whose only shared lines are Actions plumbing', () => {
    // Verbatim from the first live run's digest: `CI / ci` is `if: always()` over
    // `needs: [everything]`, so it flips whenever ANY child job flips and its
    // shared "signature" names no failure mode. It scored 3 and was dispatched.
    const plumbing = [
      'echo "::error::One or more jobs failed or were cancelled"',
      '##[error]One or more jobs failed or were cancelled',
      '##[error]Process completed with exit code 1.',
    ];
    const out = localizeFlake([{ lines: plumbing }, { lines: plumbing }, { lines: plumbing }]);
    expect(out.localized).toBe(false);
    expect(out.reason).toMatch(/plumbing/i);
    expect(out.reason).toMatch(/gate\/aggregator/i);
    // The signature is still reported so the digest can show what was seen.
    expect(out.signature).toContain('One or more jobs failed');
  });

  it('still localizes when a real failure line rides along with plumbing', () => {
    const lines = [
      '##[error]Process completed with exit code 1.',
      'FAIL packages/webapp/tests/kernel/host.test.ts > boots',
      'AssertionError: expected 3 to be 4',
    ];
    const out = localizeFlake([{ lines }, { lines }]);
    expect(out.localized).toBe(true);
    expect(out.signature).toContain('AssertionError');
  });

  it('refuses to localize from fewer than two readable logs', () => {
    const out = localizeFlake([{ lines: ['FAIL tests/a.test.ts > alpha'] }]);
    expect(out.localized).toBe(false);
    expect(out.reason).toContain('at least two');
    expect(localizeFlake().localized).toBe(false);
  });
});

/* ───────────────────────── Step 7: the digest ───────────────────────── */

describe('buildDigest', () => {
  const coverage = {
    days: [
      { day: '2025-06-09', retrieved: 300, totalCount: 300 },
      { day: '2025-06-10', retrieved: 1000, totalCount: 2411 },
    ],
    logReads: 4,
    maxLogReads: 6,
    apiCalls: 57,
  };

  it('lists sub-threshold candidates as well as dispatched ones', () => {
    const top = candidate();
    const tail = candidate({ job: 'cherry', slug: jobSlug('CI', 'cherry'), flakeScore: 1 });
    const { dispatch, decisions } = filterCandidates({ candidates: [top, tail], now: NOW });
    const digest = buildDigest({
      candidates: [top, tail],
      decisions,
      dispatched: dispatch,
      coverage,
      now: NOW,
    });
    expect(digest).toContain('Sub-threshold tail (1)');
    expect(digest).toContain('CI / cherry');
    expect(digest).toContain('CI / node-server');
    expect(digest).toContain('Dispatched a fixer');
    expect(digest).toContain('automation/flaky-fix/ci--cherry');
    expect(digest).toContain('binds a port');
  });

  it('flags a truncated day loudly so a short scan is not read as a quiet week', () => {
    const digest = buildDigest({ coverage, now: NOW });
    expect(digest).toContain('⚠️ truncated');
    expect(digest).toContain('TRUNCATED on 1 day(s)');
    expect(digest).toContain('2025-06-10');
    expect(digest).toContain('Job logs read: **4**');
    expect(digest).toContain('GitHub API calls: **57**');
  });

  it('says a complete scan is complete, and that an empty week is fine', () => {
    const digest = buildDigest({
      coverage: { days: [{ day: '2025-06-10', retrieved: 12, totalCount: 12 }] },
      now: NOW,
    });
    expect(digest).toContain('Coverage complete');
    expect(digest).toContain('No dispatch this week');
    expect(digest).toContain('Sub-threshold tail (0)');
  });

  it('renders without any coverage data at all', () => {
    expect(buildDigest()).toContain('no days scanned');
  });
});

/* ───────────────────────── Step 6: the dispatch brief ───────────────────────── */

describe('buildPrompt', () => {
  const prompt = buildPrompt(candidate());

  it('names the job, the score, and the evidence links', () => {
    expect(prompt).toContain('CI / node-server');
    expect(prompt).toContain('3 distinct commits in the last 7 days');
    expect(prompt).toContain('u1 — attempt 1 failure → attempt 2 success');
    expect(prompt).toContain('FAIL tests/spawn.test.ts > binds a port');
  });

  it('contains the full banned-fix list verbatim', () => {
    expect(prompt).toContain('a retry hides');
    expect(prompt).toContain('`CI_RETRIES`');
    expect(prompt).toContain('vitest.config.ts');
    expect(prompt).toContain('test.retry(');
    expect(prompt).toContain('bare `sleep`');
    expect(prompt).toContain('loosening or deleting an assertion');
    expect(prompt).toContain('`.skip` / `.todo`');
    expect(prompt).toContain('widening a timeout');
    expect(prompt).toContain('.agents/skills/writing-slicc-tests/SKILL.md');
    expect(prompt).toContain('docs/development.md');
    expect(prompt).toContain('stop and report back');
  });

  it('demands 10 verification iterations and exactly one branded PR', () => {
    expect(prompt).toContain('at least 10 iterations');
    expect(prompt).toContain('automation/flaky-fix/ci--node-server');
    expect(prompt).toContain('exactly ONE** pull request');
    expect(prompt).toContain('`flaky-fix`');
    expect(prompt).toContain('Do not merge');
  });

  it('pushes the branch and leaves PR creation to the deterministic step', () => {
    // A PR opened by Claude's `gh` is authored by github-actions[bot], whose
    // checks GitHub queues as `action_required` until a human approves them —
    // useless for a determinism fix. The workflow opens it with BOT_PAT from the
    // title/body files instead, so the brief must name both env vars and never
    // invoke `gh pr create`.
    expect(prompt).toContain('git push -u origin automation/flaky-fix/ci--node-server');
    expect(prompt).toContain('$PR_TITLE_FILE');
    expect(prompt).toContain('$PR_BODY_FILE');
    expect(prompt).not.toMatch(/^\s*gh pr create/m);
    expect(prompt.match(/gh pr create/g)).toHaveLength(1);
    expect(prompt).toContain('action_required');
  });

  it('tolerates a candidate with no captured evidence', () => {
    const bare = buildPrompt({ workflow: 'CI', job: 'x', slug: 'ci--x', flakeScore: 2 });
    expect(bare).toContain('(no evidence links captured)');
    expect(bare).toContain('(no common signature captured)');
  });
});

/* ───────────── offline end-to-end: the whole scan over a fixture ───────────── */

/**
 * A synthetic week: one CI workflow, one job (`node-server`) that flipped on two
 * distinct commits via re-runs, plus a job that flipped only once (the
 * sub-threshold tail) and a `release-gate` flip that must be excluded.
 */
function fixtureApi(now) {
  const days = dayWindows(now, CONFIG.WINDOW_DAYS);
  const today = days.at(-1);
  const run = (id, headSha, extra = {}) => ({
    id,
    name: 'CI',
    head_sha: headSha,
    head_branch: 'feature',
    event: 'pull_request',
    conclusion: 'success',
    run_attempt: 2,
    html_url: `https://gh/run/${id}`,
    ...extra,
  });
  const runsByDay = {
    [today]: [run(1, 'aaaaaaaa1111'), run(2, 'bbbbbbbb2222'), run(3, 'cccccccc3333')],
  };
  const jobsByAttempt = {
    '1/1': [
      { name: 'node-server', conclusion: 'failure', id: 101 },
      { name: 'cherry', conclusion: 'failure', id: 111 },
      { name: 'release-gate', conclusion: 'failure', id: 121 },
    ],
    '1/2': [
      { name: 'node-server', conclusion: 'success', id: 102 },
      { name: 'cherry', conclusion: 'success', id: 112 },
      { name: 'release-gate', conclusion: 'success', id: 122 },
    ],
    '2/1': [{ name: 'node-server', conclusion: 'failure', id: 201 }],
    '2/2': [{ name: 'node-server', conclusion: 'success', id: 202 }],
    '3/1': [
      { name: 'node-server', conclusion: 'failure', id: 301 },
      { name: 'release-gate', conclusion: 'failure', id: 321 },
    ],
    '3/2': [
      { name: 'node-server', conclusion: 'failure', id: 302 },
      { name: 'release-gate', conclusion: 'success', id: 322 },
    ],
  };
  const logs = {
    101: 'FAIL packages/node-server/tests/spawn.test.ts > binds the bridge port\nError: EADDRINUSE 5710\ntook 1200 ms',
    201: 'FAIL packages/node-server/tests/spawn.test.ts > binds the bridge port\nError: EADDRINUSE 5710\ntook 87 ms',
  };
  let calls = 0;
  return {
    calls: () => calls,
    listRunsPage: async (day, page) => {
      calls += 1;
      const all = runsByDay[day] ?? [];
      return { total_count: all.length, workflow_runs: page === 1 ? all : [] };
    },
    listAttemptJobs: async (runId, attempt) => {
      calls += 1;
      return jobsByAttempt[`${runId}/${attempt}`] ?? [];
    },
    listRunJobs: async () => {
      calls += 1;
      return [];
    },
    fetchJobLog: async (jobId) => {
      calls += 1;
      return logs[jobId] ?? '';
    },
    listFixPulls: async () => {
      calls += 1;
      return [];
    },
  };
}

describe('scan (offline, fixture-driven)', () => {
  it('queries one page per day, finds the flip, scores it, and builds the prompt', async () => {
    const api = fixtureApi(NOW);
    const result = await scan({ api, now: NOW });

    // One runs query per day of the window — the 1000-item-cap workaround.
    // WINDOW_DAYS + 1: the trailing window touches one extra UTC day, which is
    // queried whole and then trimmed to the exact cutoff.
    expect(result.coverageDays).toHaveLength(CONFIG.WINDOW_DAYS + 1);
    expect(result.coverageDays.every((d) => d.retrieved === d.totalCount)).toBe(true);

    // node-server scores 2, not 3: run 3 failed on BOTH attempts, which is a
    // broken job rather than a flake, so it contributes no flip.
    expect(result.candidates.map((c) => [c.job, c.flakeScore])).toEqual([
      ['node-server', 2],
      ['release-gate', 2],
      ['cherry', 1],
    ]);

    expect(result.dispatch).toHaveLength(1);
    expect(result.dispatch[0].job).toBe('node-server');
    expect(result.dispatch[0].signature).toContain('binds the bridge port');

    const actions = Object.fromEntries(result.decisions.map((d) => [d.job, d.action]));
    expect(actions).toEqual({
      'node-server': 'dispatch',
      'release-gate': 'excluded',
      cherry: 'below-threshold',
    });

    expect(result.digest).toContain('Dispatched a fixer for **CI / node-server**');
    expect(result.digest).toContain('Sub-threshold tail (1)');
    expect(result.digest).toContain('Coverage complete');
    expect(buildPrompt(result.dispatch[0])).toContain('EADDRINUSE');
  });

  it('dispatches nothing when the same job merely fails twice without flipping', async () => {
    const api = fixtureApi(NOW);
    const original = api.listAttemptJobs;
    api.listAttemptJobs = async (runId, attempt) =>
      // Never green on a later attempt → no flip, no flake.
      (await original(runId, attempt)).map((j) => ({ ...j, conclusion: 'failure' }));
    const result = await scan({ api, now: NOW });
    expect(result.candidates).toEqual([]);
    expect(result.dispatch).toEqual([]);
    expect(result.digest).toContain('No dispatch this week');
  });

  it('honours the job override input', async () => {
    const result = await scan({ api: fixtureApi(NOW), now: NOW, jobOverride: 'cherry' });
    expect(result.candidates.map((c) => c.job)).toEqual(['cherry']);
    expect(result.dispatch).toEqual([]);
  });
});
