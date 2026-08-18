import { describe, expect, it } from 'vitest';
import {
  buildDispatchMarker,
  buildSkipMarker,
  CONFIG,
  classifyFailure,
  classifyFailures,
  decidePrAction,
  dispatchBudget,
  extractLogExcerpt,
  formatFailuresForMatrix,
  hasRerunForSha,
  isAutomationPr,
  parseMarkers,
  summarizeChecks,
} from './lib.mjs';

const NOW = new Date('2025-01-15T12:00:00Z');
const minutesAgo = (m) => new Date(NOW.getTime() - m * 60_000).toISOString();
const SHA = 'abc1234def5678000000000000000000000000aa';
const OTHER_SHA = 'bbb1234def5678000000000000000000000000cc';

/** A PR that is past every Step-4 gate; the rubric decides it. */
function candidate(overrides = {}) {
  const {
    failing = [{ name: 'test', conclusion: 'failure', logExcerpt: '' }],
    labels = [],
    markers = {},
    ...rest
  } = overrides;
  return {
    pr: {
      number: 42,
      title: 'chore(deps): bump thing',
      headRef: 'renovate/thing-1.x',
      headSha: SHA,
      labels,
      user: { type: 'Bot', login: 'renovate[bot]' },
    },
    checks: { failing, pending: false, newestFailureAt: minutesAgo(60) },
    markers,
    latestHumanActivityAt: null,
    alreadyRerunSha: false,
    now: NOW,
    ...rest,
  };
}

describe('isAutomationPr', () => {
  it('qualifies a bot author', () => {
    expect(isAutomationPr({ user: { type: 'Bot' }, head: { ref: 'feature/x' } })).toBe(true);
  });

  it('qualifies a human login on an automation branch (bot-PAT-authored PR)', () => {
    expect(
      isAutomationPr({
        user: { type: 'User', login: 'trieloff' },
        head: { ref: 'automation/coverage-ratchet' },
      })
    ).toBe(true);
    expect(isAutomationPr({ user: { type: 'User' }, head: { ref: 'rum-fix/issue-12' } })).toBe(
      true
    );
    expect(isAutomationPr({ user: { type: 'User' }, head: { ref: 'renovate/vite-6.x' } })).toBe(
      true
    );
  });

  it('drops a human PR on a human branch', () => {
    expect(isAutomationPr({ user: { type: 'User' }, head: { ref: 'fix/2139-grants' } })).toBe(
      false
    );
  });

  it('tolerates missing input', () => {
    expect(isAutomationPr(null)).toBe(false);
    expect(isAutomationPr({})).toBe(false);
  });

  it('accepts the flattened headRef shape', () => {
    expect(isAutomationPr({ headRef: 'automation/x' })).toBe(true);
  });
});

describe('screenPr fork guard', () => {
  // The fix job checks out the bare `head.ref` in THIS repository. A fork PR
  // therefore either fails on a missing branch or, if a branch of the same name
  // exists here, edits and pushes the WRONG one — and the dispatch label plus
  // SHA marker are written before the checkout, so nothing retries.
  const forked = (headRepo) =>
    decidePrAction(candidate({ pr: { ...candidate().pr, headRepo }, repo: 'ai-ecoverse/slicc' }));

  it('refuses a PR whose head branch lives in a fork', () => {
    const out = forked('someone-else/slicc');
    expect(out.action).toBe('skip');
    expect(out.reason).toContain('someone-else/slicc');
    expect(out.announce).toBe(false);
  });

  it('refuses a PR whose fork was deleted (head.repo is null)', () => {
    const out = forked(null);
    expect(out.action).toBe('skip');
    expect(out.reason).toContain('deleted fork');
  });

  it('lets a same-repo branch through to the rubric', () => {
    // The baseline fixture is itself a skip ("no plausible cause"), so what
    // matters is that the fork guard is not what decided it.
    expect(forked('ai-ecoverse/slicc').reason).not.toMatch(/Head branch lives in/);
  });

  it('reads the nested head.repo shape too', () => {
    const out = decidePrAction(
      candidate({
        pr: {
          ...candidate().pr,
          head: { sha: SHA, ref: 'renovate/x', repo: { full_name: 'f/x' } },
        },
        repo: 'ai-ecoverse/slicc',
      })
    );
    expect(out.action).toBe('skip');
    expect(out.reason).toContain('f/x');
  });

  it('does not guess when the head repo is simply not stated', () => {
    // Fixtures that never mention a head repo must keep their old meaning:
    // absence is not evidence of a fork.
    expect(decidePrAction(candidate({ repo: 'ai-ecoverse/slicc' })).reason).not.toMatch(
      /Head branch lives in/
    );
  });
});

describe('summarizeChecks', () => {
  it('folds check-runs and statuses into one verdict', () => {
    const out = summarizeChecks({
      checkRuns: [
        {
          name: 'lint',
          status: 'completed',
          conclusion: 'failure',
          completed_at: '2025-01-15T10:00:00Z',
        },
        { name: 'build', status: 'completed', conclusion: 'success' },
        {
          name: 'flaky',
          status: 'completed',
          conclusion: 'timed_out',
          completed_at: '2025-01-15T11:00:00Z',
        },
      ],
      statuses: [{ context: 'vercel', state: 'error', updated_at: '2025-01-15T09:00:00Z' }],
    });
    expect(out.failing.map((f) => f.name)).toEqual(['lint', 'flaky', 'vercel']);
    expect(out.pending).toBe(false);
    expect(out.newestFailureAt).toBe('2025-01-15T11:00:00Z');
  });

  it('marks queued/in_progress checks as pending', () => {
    const out = summarizeChecks({
      checkRuns: [
        { name: 'test', status: 'in_progress' },
        { name: 'lint', status: 'queued' },
      ],
      statuses: [{ context: 'ci', state: 'pending' }],
    });
    expect(out.pending).toBe(true);
    expect(out.failing).toEqual([]);
  });

  it('reports a green commit as neither failing nor pending', () => {
    const out = summarizeChecks({
      checkRuns: [{ name: 'test', status: 'completed', conclusion: 'success' }],
      statuses: [{ context: 'ci', state: 'success' }],
    });
    expect(out).toMatchObject({ failing: [], pending: false, newestFailureAt: null });
  });

  it('tolerates missing/garbage input', () => {
    expect(summarizeChecks()).toMatchObject({ failing: [], pending: false });
    expect(summarizeChecks({ checkRuns: null, statuses: 'nope' }).failing).toEqual([]);
  });

  it('ignores neutral and skipped conclusions', () => {
    const out = summarizeChecks({
      checkRuns: [
        { name: 'a', status: 'completed', conclusion: 'neutral' },
        { name: 'b', status: 'completed', conclusion: 'skipped' },
      ],
    });
    expect(out.failing).toEqual([]);
  });
});

describe('classifyFailure', () => {
  it('classifies artifact/network/registry/runner/cancel failures as infra', () => {
    const cases = [
      ['upload artifacts', 'Failed to upload artifact: 500'],
      ['test', 'getaddrinfo ENOTFOUND registry.example.com'],
      ['install', 'npm ERR! network request to https://registry.npmjs.org failed'],
      ['test', 'The runner has received a shutdown signal.'],
      ['test', 'The operation was canceled.'],
    ];
    for (const [jobName, logExcerpt] of cases) {
      expect(classifyFailure({ jobName, logExcerpt }).kind, `${jobName}/${logExcerpt}`).toBe(
        'infra'
      );
    }
  });

  it('classifies lint/type/test/snapshot/lockfile/conflict failures as code', () => {
    const cases = [
      ['lint', 'biome found 3 errors'],
      ['typecheck', "error TS2345: Argument of type 'x' is not assignable"],
      ['test', 'AssertionError: expected 1 to be 2'],
      ['coverage', 'ERROR: Coverage for lines (81%) does not meet threshold'],
      ['install', 'npm ci can only install packages when package-lock.json is in sync'],
      ['merge', 'CONFLICT (content): Merge conflict in package.json'],
    ];
    for (const [jobName, logExcerpt] of cases) {
      expect(classifyFailure({ jobName, logExcerpt }).kind, `${jobName}/${logExcerpt}`).toBe(
        'code'
      );
    }
  });

  it('prefers the code signature when a cancel line accompanies an assertion failure', () => {
    const out = classifyFailure({
      jobName: 'test',
      logExcerpt: 'AssertionError: expected true to be false\nThe operation was canceled.',
    });
    expect(out.kind).toBe('code');
  });

  it('blocks a release/deploy/publish/migration job by name alone', () => {
    for (const jobName of ['release', 'publish-worker', 'deploy staging', 'db migrate']) {
      expect(classifyFailure({ jobName, logExcerpt: 'biome found 2 errors' }).kind, jobName).toBe(
        'blocked'
      );
    }
  });

  it('blocks auth, expired-token, quota, secret, schema, dependency and CI-config failures', () => {
    const cases = [
      ['ci', 'remote: Bad credentials'],
      ['ci', 'The provided token has expired'],
      ['ci', 'You exceeded your quota for this month'],
      ['ci', 'Missing required secret AWS_BEARER_TOKEN_BEDROCK'],
      ['ci', 'schema migration failed on step 4'],
      ['ci', 'npm ERR! ERESOLVE unable to resolve dependency tree'],
      ['ci', 'Invalid workflow file: .github/workflows/ci.yml'],
    ];
    for (const [jobName, logExcerpt] of cases) {
      expect(classifyFailure({ jobName, logExcerpt }).kind, logExcerpt).toBe('blocked');
    }
  });

  it('returns unknown when nothing matches', () => {
    const out = classifyFailure({ jobName: 'mystery', logExcerpt: 'exit 7' });
    expect(out.kind).toBe('unknown');
    expect(out.reason).toMatch(/no plausible cause/i);
  });

  it('tolerates missing input', () => {
    expect(classifyFailure().kind).toBe('unknown');
  });
});

describe('classifyFailures', () => {
  it('lets blocked dominate code and infra', () => {
    expect(
      classifyFailures([
        { name: 'lint', logExcerpt: 'biome found 1 error' },
        { name: 'release', logExcerpt: 'npm publish failed' },
      ]).kind
    ).toBe('blocked');
  });

  it('lets code beat infra', () => {
    expect(
      classifyFailures([
        { name: 'upload', logExcerpt: 'Failed to upload artifact' },
        { name: 'lint', logExcerpt: 'biome found 1 error' },
      ]).kind
    ).toBe('code');
  });

  it('reports unknown for an empty list', () => {
    expect(classifyFailures([]).kind).toBe('unknown');
    expect(classifyFailures().kind).toBe('unknown');
  });
});

describe('markers', () => {
  it('round-trips skip and dispatch markers', () => {
    const comments = [
      { body: `skipping\n${buildSkipMarker(SHA)}` },
      { body: `dispatching\n${buildDispatchMarker(OTHER_SHA)}` },
      { body: 'unrelated chatter' },
    ];
    const markers = parseMarkers(comments);
    expect(markers.skippedShas.has(SHA)).toBe(true);
    expect(markers.dispatchedShas.has(OTHER_SHA)).toBe(true);
    expect(markers.attempts).toBe(1);
  });

  it('counts attempts by distinct dispatched SHA, not by comment count', () => {
    const markers = parseMarkers([
      { body: buildDispatchMarker(SHA) },
      { body: buildDispatchMarker(SHA) },
      { body: buildDispatchMarker(OTHER_SHA) },
    ]);
    expect(markers.attempts).toBe(2);
  });

  it('tolerates missing/garbage comments', () => {
    expect(parseMarkers().attempts).toBe(0);
    expect(parseMarkers([{}, null, { body: 42 }]).attempts).toBe(0);
  });
});

describe('hasRerunForSha', () => {
  it('is true when any run for the SHA has run_attempt > 1', () => {
    expect(hasRerunForSha([{ run_attempt: 1 }, { run_attempt: 2 }])).toBe(true);
  });

  it('is false on first attempts only, or no runs', () => {
    expect(hasRerunForSha([{ run_attempt: 1 }, {}])).toBe(false);
    expect(hasRerunForSha([])).toBe(false);
    expect(hasRerunForSha()).toBe(false);
  });
});

describe('dispatchBudget', () => {
  it('caps at MAX_DISPATCHES_PER_RUN when nothing is in flight', () => {
    expect(dispatchBudget({ openFixes: 0 })).toBe(CONFIG.MAX_DISPATCHES_PER_RUN);
    expect(dispatchBudget()).toBe(CONFIG.MAX_DISPATCHES_PER_RUN);
  });

  it('shrinks to the open-fix headroom', () => {
    expect(dispatchBudget({ openFixes: 3 })).toBe(CONFIG.MAX_OPEN_FIXES - 3);
    expect(dispatchBudget({ openFixes: 4 })).toBe(1);
  });

  it('is zero once MAX_OPEN_FIXES is reached or exceeded', () => {
    expect(dispatchBudget({ openFixes: CONFIG.MAX_OPEN_FIXES })).toBe(0);
    expect(dispatchBudget({ openFixes: 99 })).toBe(0);
  });
});

describe('decidePrAction — Step-4 silent drops', () => {
  it('drops a non-automation PR', () => {
    const out = decidePrAction(
      candidate({ pr: { number: 1, headRef: 'fix/thing', headSha: SHA, user: { type: 'User' } } })
    );
    expect(out).toMatchObject({ action: 'skip', announce: false });
    expect(out.reason).toMatch(/not a routine automation PR/i);
  });

  it('drops a green PR', () => {
    const out = decidePrAction(candidate({ failing: [] }));
    expect(out).toMatchObject({ action: 'skip', announce: false });
    expect(out.reason).toMatch(/green/i);
  });

  it('drops a PR whose checks are still running', () => {
    const out = decidePrAction(candidate({ failing: [], checks: { failing: [], pending: true } }));
    expect(out.reason).toMatch(/still running/i);
    expect(out.announce).toBe(false);
  });

  it('drops a PR inside the settling window', () => {
    const out = decidePrAction(
      candidate({
        checks: { failing: [{ name: 'lint' }], pending: false, newestFailureAt: minutesAgo(5) },
      })
    );
    expect(out.reason).toMatch(/settling window/i);
    expect(out.announce).toBe(false);
  });

  it('acts once the settling window has elapsed', () => {
    const out = decidePrAction(
      candidate({
        failing: [{ name: 'lint', logExcerpt: 'biome found 2 errors' }],
        checks: {
          failing: [{ name: 'lint', logExcerpt: 'biome found 2 errors' }],
          pending: false,
          newestFailureAt: minutesAgo(CONFIG.SETTLING_MINUTES + 1),
        },
      })
    );
    expect(out.action).toBe('dispatch');
  });

  it('drops a PR with recent human activity', () => {
    const out = decidePrAction(candidate({ latestHumanActivityAt: minutesAgo(10) }));
    expect(out.reason).toMatch(/a human commented, reviewed, or pushed/i);
    expect(out.announce).toBe(false);
  });

  it('ignores human activity older than the window', () => {
    const out = decidePrAction(
      candidate({
        failing: [{ name: 'lint', logExcerpt: 'biome found 2 errors' }],
        latestHumanActivityAt: minutesAgo(CONFIG.HUMAN_ACTIVITY_MINUTES + 5),
      })
    );
    expect(out.action).toBe('dispatch');
  });

  // `targeted` is the workflow_dispatch entry point: an operator naming one PR
  // by number. It waives ONLY the two "yield to somebody else" waits.
  it('waives the settling window for a targeted run', () => {
    const out = decidePrAction(
      candidate({
        failing: [{ name: 'lint', logExcerpt: 'biome found 2 errors' }],
        checks: {
          failing: [{ name: 'lint', logExcerpt: 'biome found 2 errors' }],
          pending: false,
          newestFailureAt: minutesAgo(1),
        },
        targeted: true,
      })
    );
    expect(out.action).toBe('dispatch');
  });

  it('waives recent human activity for a targeted run', () => {
    const out = decidePrAction(
      candidate({
        failing: [{ name: 'lint', logExcerpt: 'biome found 2 errors' }],
        latestHumanActivityAt: minutesAgo(1),
        targeted: true,
      })
    );
    expect(out.action).toBe('dispatch');
  });

  it('still enforces every non-time guard for a targeted run', () => {
    const base = candidate({ targeted: true });
    const notAutomation = decidePrAction({
      ...base,
      pr: { ...base.pr, headRef: 'feature/x', user: { type: 'User', login: 'trieloff' } },
    });
    expect(notAutomation.reason).toMatch(/not a routine automation pr/i);

    const green = decidePrAction(
      candidate({ failing: [], checks: { failing: [], pending: false }, targeted: true })
    );
    expect(green.reason).toMatch(/green/i);

    const selfHealing = decidePrAction(
      candidate({ labels: [{ name: 'patched-dependency' }], targeted: true })
    );
    expect(selfHealing.reason).toContain('patched-dependency');

    const secrets = decidePrAction(
      candidate({
        failing: [{ name: 'deploy', logExcerpt: 'invalid credentials for the release token' }],
        checks: {
          failing: [{ name: 'deploy', logExcerpt: 'invalid credentials for the release token' }],
          pending: false,
          newestFailureAt: minutesAgo(CONFIG.SETTLING_MINUTES + 1),
        },
        targeted: true,
      })
    );
    expect(secrets.action).toBe('skip');
  });

  it('drops the self-healing renovate labels', () => {
    for (const label of ['patched-dependency', 'formatter-bump']) {
      const out = decidePrAction(candidate({ labels: [{ name: label }] }));
      expect(out.reason).toContain(label);
      expect(out.announce).toBe(false);
    }
  });

  it('drops when a dispatch is already recorded for this head SHA', () => {
    const out = decidePrAction(
      candidate({
        markers: { dispatchedShas: new Set([SHA]), skippedShas: new Set(), attempts: 1 },
      })
    );
    expect(out.reason).toMatch(/already dispatched for head SHA/i);
    expect(out.announce).toBe(false);
  });

  it('drops when the per-PR attempt cap is exhausted', () => {
    const out = decidePrAction(
      candidate({
        markers: {
          dispatchedShas: new Set([OTHER_SHA, 'ccc1234def5678000000000000000000000000dd']),
          skippedShas: new Set(),
          attempts: CONFIG.MAX_ATTEMPTS_PER_PR,
        },
      })
    );
    expect(out.reason).toMatch(/leaving this PR for a human/i);
    expect(out.announce).toBe(false);
  });

  it('drops when this head SHA was already skipped, but a new head SHA is eligible again', () => {
    const markers = { skippedShas: new Set([SHA]), dispatchedShas: new Set(), attempts: 0 };
    const failing = [{ name: 'lint', logExcerpt: 'biome found 2 errors' }];
    const dropped = decidePrAction(
      candidate({
        failing,
        markers,
        checks: { failing, pending: false, newestFailureAt: minutesAgo(60) },
      })
    );
    expect(dropped.reason).toMatch(/already skipped/i);
    expect(dropped.announce).toBe(false);

    const fresh = candidate({
      failing,
      markers,
      checks: { failing, pending: false, newestFailureAt: minutesAgo(60) },
    });
    fresh.pr.headSha = OTHER_SHA;
    expect(decidePrAction(fresh).action).toBe('dispatch');
  });
});

describe('decidePrAction — rubric', () => {
  const withFailure = (logExcerpt, name = 'test', extra = {}) => {
    const failing = [{ name, logExcerpt }];
    return candidate({
      failing,
      checks: { failing, pending: false, newestFailureAt: minutesAgo(60) },
      ...extra,
    });
  };

  it('re-runs an infrastructure failure, silently', () => {
    const out = decidePrAction(withFailure('getaddrinfo ENOTFOUND proxy.local'));
    expect(out.action).toBe('rerun');
    expect(out.announce).toBe(false);
    expect(out.reason).toMatch(/re-running the failed jobs/i);
  });

  it('skips an infrastructure failure when this head SHA was already re-run', () => {
    const out = decidePrAction(
      withFailure('Failed to upload artifact', 'upload', { alreadyRerunSha: true })
    );
    expect(out.action).toBe('skip');
    expect(out.announce).toBe(true);
    expect(out.reason).toMatch(/not a flake/i);
  });

  it('dispatches a code failure', () => {
    const out = decidePrAction(withFailure('error TS2739: missing properties', 'typecheck'));
    expect(out.action).toBe('dispatch');
    expect(out.announce).toBe(true);
    expect(out.category).toBe('types');
  });

  it('skips every hard-override category with a comment', () => {
    const cases = [
      ['ci', 'remote: Bad credentials'],
      ['ci', 'Missing required secret FOO'],
      ['ci', 'You exceeded your quota'],
      ['ci', 'The token has expired'],
      ['ci', 'schema migration failed'],
      ['release', 'anything at all'],
      ['ci', 'npm ERR! ERESOLVE unable to resolve dependency tree'],
      ['ci', 'Invalid workflow file: .github/workflows/ci.yml'],
    ];
    for (const [name, log] of cases) {
      const out = decidePrAction(withFailure(log, name));
      expect(out.action, `${name}/${log}`).toBe('skip');
      expect(out.announce).toBe(true);
    }
  });

  it('skips when it cannot name a plausible cause', () => {
    const out = decidePrAction(withFailure('exit code 7', 'mystery'));
    expect(out.action).toBe('skip');
    expect(out.announce).toBe(true);
    expect(out.reason).toMatch(/no plausible cause/i);
  });
});

describe('formatFailuresForMatrix', () => {
  it('produces a single line with no newlines and no Actions expression', () => {
    const out = formatFailuresForMatrix([
      { name: 'lint', conclusion: 'failure', logExcerpt: 'line one\nline two ${{ secrets.X }}' },
      { name: 'test', conclusion: 'timed_out' },
    ]);
    expect(out).not.toMatch(/[\r\n]/);
    expect(out).not.toContain('${{');
    expect(out).toContain('lint: failure');
    expect(out).toContain('test: timed_out');
  });

  it('truncates to the requested budget and tolerates empty input', () => {
    expect(formatFailuresForMatrix([{ name: 'a', logExcerpt: 'x'.repeat(500) }], 40)).toHaveLength(
      40
    );
    expect(formatFailuresForMatrix()).toBe('');
  });

  it('falls back to a status description when there is no log', () => {
    expect(
      formatFailuresForMatrix([
        { name: 'vercel', conclusion: 'error', description: 'Build failed' },
      ])
    ).toContain('Build failed');
  });
});

describe('extractLogExcerpt', () => {
  it('strips Actions timestamps and keeps the interesting tail', () => {
    const log = [
      '2025-01-15T11:59:00.1234567Z ##[group]Run npm run lint',
      '2025-01-15T11:59:01.1234567Z boring output',
      '2025-01-15T11:59:02.1234567Z biome found 2 errors',
    ].join('\n');
    const out = extractLogExcerpt(log);
    expect(out).toBe('biome found 2 errors');
  });

  it('falls back to the raw tail when no line looks interesting', () => {
    expect(extractLogExcerpt('hello\nworld')).toBe('hello\nworld');
  });

  it('honours the char budget and tolerates empty input', () => {
    expect(extractLogExcerpt(`error ${'y'.repeat(500)}`, 50)).toHaveLength(50);
    expect(extractLogExcerpt()).toBe('');
  });
});
