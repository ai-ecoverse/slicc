import { describe, expect, it } from 'vitest';
import { isAutomationPr } from '../pr-fix-dispatcher/lib.mjs';
import {
  buildAuthorPrompt,
  buildDigest,
  buildMarker,
  buildTriagePrompt,
  CONFIG,
  classifyIssue,
  DECIDED_LABELS,
  DENYLIST_LABELS,
  detectSmells,
  dispatchBudget,
  formatRejections,
  formatSkipComment,
  formatStaleComment,
  hasLinkedOpenPr,
  isCandidate,
  isDispatcherPr,
  issueBranch,
  LABELS,
  labelNames,
  scoreCandidate,
  screenIssue,
  selectCandidates,
  selectStalePrs,
} from './lib.mjs';

const NOW = new Date('2026-09-01T12:00:00Z');
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const daysAgo = (d) => hoursAgo(d * 24);

/** An issue that passes every screening rule. */
function issue(overrides = {}) {
  return {
    number: 100,
    title: 'Paranoia: session-freezer updateSessionsIndex swallows all readFile errors',
    body: 'The catch in packages/webapp/src/sessions/session-freezer.ts swallows every error.',
    state: 'open',
    created_at: daysAgo(3),
    updated_at: daysAgo(1),
    html_url: 'https://github.com/o/r/issues/100',
    labels: [{ name: 'agentic-debt' }],
    assignee: null,
    assignees: [],
    ...overrides,
  };
}

describe('CONFIG', () => {
  it('carries the Cosmos-era knobs verbatim', () => {
    expect(CONFIG).toMatchObject({
      MAX_DISPATCHES_PER_RUN: 5,
      MAX_CANDIDATES_PER_SOURCE: 25,
      MAX_OPEN_PRS: 10,
      SETTLING_AGE_HOURS: 1,
      STALE_PR_DAYS: 7,
    });
  });
});

describe('LABELS', () => {
  it('uses the new vocabulary but reuses the existing failure label', () => {
    expect(LABELS.ready).toBe('backlog-ready');
    expect(LABELS.dispatched).toBe('backlog-dispatched');
    expect(LABELS.skipped).toBe('backlog-skipped');
    expect(LABELS.stale).toBe('backlog-stale');
    expect(LABELS.failed).toBe('cosmos-dispatch-failed');
  });

  it('treats the legacy Cosmos labels as equivalent when excluding candidates', () => {
    expect(LABELS.legacyDispatched).toContain('cosmos-dispatched');
    expect(LABELS.legacySkipped).toContain('cosmos-skipped');
    expect(DECIDED_LABELS).toEqual(
      expect.arrayContaining([
        'backlog-ready',
        'backlog-dispatched',
        'backlog-skipped',
        'cosmos-dispatched',
        'cosmos-skipped',
        'cosmos-dispatch-failed',
      ])
    );
  });
});

describe('labelNames', () => {
  it('normalises both label shapes to lowercase and drops blanks', () => {
    expect(labelNames({ labels: [{ name: 'Bug' }, 'Area/Docs', { name: '' }, null] })).toEqual([
      'bug',
      'area/docs',
    ]);
  });

  it('tolerates a missing label array', () => {
    expect(labelNames({})).toEqual([]);
    expect(labelNames(null)).toEqual([]);
  });
});

describe('screenIssue', () => {
  it('accepts a well-formed, aged, unassigned, undecided issue', () => {
    expect(screenIssue(issue(), { now: NOW })).toMatchObject({ eligible: true, code: 'eligible' });
    expect(isCandidate(issue(), { now: NOW })).toBe(true);
  });

  it('rejects a pull request masquerading as an issue in GET /issues', () => {
    expect(screenIssue(issue({ pull_request: { url: 'x' } }), { now: NOW })).toMatchObject({
      eligible: false,
      code: 'pull-request',
    });
  });

  it('rejects a closed issue', () => {
    expect(screenIssue(issue({ state: 'closed' }), { now: NOW })).toMatchObject({
      code: 'not-open',
    });
  });

  it('rejects an assigned issue via either assignee field', () => {
    expect(screenIssue(issue({ assignee: { login: 'a' } }), { now: NOW }).code).toBe('assigned');
    expect(screenIssue(issue({ assignees: [{ login: 'a' }] }), { now: NOW }).code).toBe('assigned');
  });

  it('rejects malformed input instead of throwing', () => {
    expect(screenIssue(null).code).toBe('malformed');
    expect(screenIssue('nope').code).toBe('malformed');
  });

  it('rejects every denylist label', () => {
    for (const label of DENYLIST_LABELS) {
      expect(screenIssue(issue({ labels: [{ name: label }] }), { now: NOW })).toMatchObject({
        eligible: false,
        code: 'denylisted',
      });
    }
  });

  it('does NOT deny "skill issue", which this repo applies to every new issue', () => {
    // `.github/workflows/issue-skill.yml` labels EVERY issue on `opened` as a
    // joke, so denying it disables the dispatcher outright — 14 of 17 open items
    // carried it when this was caught on the first live run.
    expect(DENYLIST_LABELS).not.toContain('skill issue');
    expect(screenIssue(issue({ labels: [{ name: 'skill issue' }] }), { now: NOW })).toMatchObject({
      eligible: true,
    });
  });

  it('attributes differing reasons to their own issues, and collapses identical ones', () => {
    // Two labels, one `denylisted` code: printing only the first reason would
    // claim #2 carries "question" when it actually carries "invalid".
    const lines = formatRejections([
      { number: 1, code: 'denylisted', reason: 'Carries "question".' },
      { number: 2, code: 'denylisted', reason: 'Carries "invalid".' },
      { number: 3, code: 'pull-request', reason: 'This is a pull request.' },
      { number: 4, code: 'pull-request', reason: 'This is a pull request.' },
    ]).join('\n');

    expect(lines).toContain('screened out 4 issue(s):');
    // Differing reasons within one code are attributed per issue…
    expect(lines).toContain('#1 — Carries "question".');
    expect(lines).toContain('#2 — Carries "invalid".');
    // …while a reason shared by the whole group stays a single unattributed line.
    expect(lines).toContain('  - pull-request (2): #3 #4');
    expect(lines).toMatch(/^ {6}This is a pull request\.$/m);
  });

  it('reports nothing when nothing was screened out', () => {
    expect(formatRejections([])).toEqual([]);
    expect(formatRejections()).toEqual([]);
  });

  it('rejects an issue this dispatcher already decided', () => {
    for (const label of [LABELS.ready, LABELS.dispatched, LABELS.skipped, LABELS.failed]) {
      expect(screenIssue(issue({ labels: [{ name: label }] }), { now: NOW }).code).toBe(
        'already-decided'
      );
    }
  });

  it('rejects an issue Cosmos already decided (legacy label equivalence)', () => {
    for (const label of ['cosmos-dispatched', 'cosmos-skipped', 'cosmos-dispatch-failed']) {
      const verdict = screenIssue(issue({ labels: [{ name: label }] }), { now: NOW });
      expect(verdict.code).toBe('already-decided');
      expect(verdict.reason).toContain(label);
    }
  });

  it('explains the re-queue escape hatch in the already-decided reason', () => {
    const verdict = screenIssue(issue({ labels: [{ name: LABELS.skipped }] }), { now: NOW });
    expect(verdict.reason).toMatch(/remove the label to re-queue/i);
  });
});

describe('screenIssue settling age', () => {
  it('rejects an issue younger than the settling window', () => {
    const verdict = screenIssue(issue({ created_at: hoursAgo(0.5) }), { now: NOW });
    expect(verdict).toMatchObject({ eligible: false, code: 'too-young' });
  });

  it('accepts an issue exactly at the boundary', () => {
    expect(screenIssue(issue({ created_at: hoursAgo(1) }), { now: NOW }).eligible).toBe(true);
  });

  it('waives only the settling wait for a targeted run', () => {
    const young = issue({ created_at: hoursAgo(0.1) });
    expect(screenIssue(young, { now: NOW, targeted: true }).eligible).toBe(true);
    // A targeted run does not waive anything else.
    expect(
      screenIssue({ ...young, labels: [{ name: 'cosmos-skipped' }] }, { now: NOW, targeted: true })
        .code
    ).toBe('already-decided');
  });

  it('does not block on an unparseable created_at', () => {
    expect(screenIssue(issue({ created_at: 'not-a-date' }), { now: NOW }).eligible).toBe(true);
  });
});

describe('hasLinkedOpenPr', () => {
  it('matches Closes / Fixes / a bare reference in the PR body', () => {
    expect(hasLinkedOpenPr({ number: 42 }, [{ body: 'Closes #42' }])).toBe(true);
    expect(hasLinkedOpenPr({ number: 42 }, [{ body: 'Fixes #42 in one line' }])).toBe(true);
    expect(hasLinkedOpenPr({ number: 42 }, [{ body: 'relates to #42' }])).toBe(true);
    expect(hasLinkedOpenPr({ number: 42 }, [{ title: 'fix: #42 terminal output' }])).toBe(true);
  });

  it('does not confuse #42 with #421', () => {
    expect(hasLinkedOpenPr({ number: 42 }, [{ body: 'Closes #421' }])).toBe(false);
  });

  it('matches the dispatcher own branch even with no body reference', () => {
    expect(hasLinkedOpenPr({ number: 7 }, [{ head: { ref: 'automation/backlog/issue-7' } }])).toBe(
      true
    );
    expect(hasLinkedOpenPr({ number: 7 }, [{ headRef: 'automation/backlog/issue-7' }])).toBe(true);
    expect(hasLinkedOpenPr({ number: 7 }, [{ headRef: 'automation/backlog/issue-70' }])).toBe(
      false
    );
  });

  it('returns false for no PRs or a numberless issue', () => {
    expect(hasLinkedOpenPr({ number: 1 }, [])).toBe(false);
    expect(hasLinkedOpenPr({}, [{ body: 'Closes #1' }])).toBe(false);
  });

  it('takes an issue with a PR in flight out of the candidate pool (the #2155 case)', () => {
    const verdict = screenIssue(issue({ number: 2155 }), {
      now: NOW,
      openPrs: [{ number: 2156, body: 'Closes #2155' }],
    });
    expect(verdict).toMatchObject({ eligible: false, code: 'pr-in-flight' });
  });
});

describe('classifyIssue', () => {
  it('recognises the debt class by label or by sin title', () => {
    expect(classifyIssue({ labels: [{ name: 'agentic-debt' }], title: 'whatever' })).toBe('debt');
    expect(classifyIssue({ labels: [{ name: 'debt:complexity' }], title: 'whatever' })).toBe(
      'debt'
    );
    expect(classifyIssue({ title: 'Necrophilia: search-tools.ts (213 LOC) is dead' })).toBe('debt');
    expect(classifyIssue({ title: 'Drift: packages/swift-optel/CLAUDE.md Scope is stale' })).toBe(
      'debt'
    );
  });

  it('does not treat Bloat as ready debt (a god-class split is architectural)', () => {
    expect(classifyIssue({ title: 'Bloat: ui/wc/wc-live.ts is 2,359 lines' })).not.toBe('debt');
  });

  it('recognises bugs, docs, and small feats', () => {
    expect(classifyIssue({ title: 'bug(git): git ls-files ignores pathspec' })).toBe('bug');
    expect(classifyIssue({ title: 'Flaky test: wc-placeholder times out' })).toBe('bug');
    expect(classifyIssue({ labels: [{ name: 'area/docs' }], title: 'stale docs' })).toBe('docs');
    expect(classifyIssue({ title: 'feat(git): implement git clean' })).toBe('feat');
    expect(classifyIssue({ title: 'test(ios): compare follower hello payload fields' })).toBe(
      'feat'
    );
  });

  it('falls back to other', () => {
    expect(classifyIssue({ title: 'Shell: make PATH and HOME real concepts' })).toBe('other');
  });
});

describe('detectSmells', () => {
  const smellsOf = (title, body = '') => detectSmells({ title, body });

  it('flags the security/authorization surface (#2062 sudo over tray)', () => {
    expect(smellsOf('Sudo over tray: approve a follower sudo prompt')).toContain(
      'security-surface'
    );
  });

  it('flags an upstream platform bug needing on-device work (#2072)', () => {
    expect(
      smellsOf('iOS transcript jump', 'workaround for an upstream iOS 26 SwiftUI bug FB20979569')
    ).toContain('platform-bug');
  });

  it('flags architectural scope (#2043 and the Bloat god-class splits)', () => {
    expect(smellsOf('DIP unlock: Atomics/SAB fast path')).toContain('architectural');
    expect(smellsOf('Bloat: kernel/facade.ts is 2,021 lines')).toContain('architectural');
  });

  it('flags an unconfirmed root cause (#2034)', () => {
    expect(
      smellsOf('Concurrent VFS reads fail', 'root cause is unconfirmed, suspected ZenFS')
    ).toEqual(expect.arrayContaining(['unconfirmed-cause', 'concurrency']));
  });

  it('flags native work CI cannot verify', () => {
    expect(smellsOf('feat(ios-app): add a share sheet')).toContain('native-unverifiable');
  });

  it('flags an unspecified UX ask', () => {
    expect(smellsOf('Shell: make PATH and HOME real concepts')).toContain('unspecified-ux');
  });

  it('returns nothing for a clean localised bug', () => {
    expect(
      smellsOf('Terminal panel: command output without trailing newline is invisible')
    ).toEqual([]);
  });
});

describe('scoreCandidate', () => {
  it('ranks a named-file debt item above a bare feat request', () => {
    const debt = scoreCandidate(issue());
    const feat = scoreCandidate({ title: 'feat(git): implement git clean', body: '' });
    expect(debt.score).toBeGreaterThan(feat.score);
    expect(debt.class).toBe('debt');
  });

  it('rewards a named file in the title over one only in the body', () => {
    const inTitle = scoreCandidate({ title: 'Drift: docs/development.md is stale', body: '' });
    const inBody = scoreCandidate({
      title: 'Drift: the dev docs are stale',
      body: 'docs/development.md',
    });
    expect(inTitle.score).toBeGreaterThan(inBody.score);
    expect(inBody.namedFile).toBe('docs/development.md');
  });

  it('rewards a concrete symptom', () => {
    const concrete = scoreCandidate({ title: 'bug(term): output is invisible', body: '' });
    const vague = scoreCandidate({ title: 'bug(term): terminal feels bad', body: '' });
    expect(concrete.score).toBeGreaterThan(vague.score);
  });

  it('penalises a very long body, but the penalty is capped', () => {
    const short = scoreCandidate({ title: 'bug(x): it throws', body: 'a'.repeat(100) });
    const long = scoreCandidate({ title: 'bug(x): it throws', body: 'a'.repeat(5000) });
    const longer = scoreCandidate({ title: 'bug(x): it throws', body: 'a'.repeat(50_000) });
    expect(long.score).toBeLessThan(short.score);
    expect(longer.score).toBe(long.score);
  });

  it('deprioritises but never disqualifies a hard-override smell', () => {
    const smelly = scoreCandidate({
      title: 'bug(sudo): approval prompt throws',
      body: '',
    });
    expect(smelly.smells).toContain('security-surface');
    expect(Number.isFinite(smelly.score)).toBe(true);
  });
});

describe('selectCandidates', () => {
  it('is deterministic: score descending, then issue number ascending', () => {
    const same = (n) => issue({ number: n, title: 'feat(git): implement git clean', body: '' });
    const { candidates } = selectCandidates([same(30), same(10), same(20)], { now: NOW });
    expect(candidates.map((c) => c.number)).toEqual([10, 20, 30]);
  });

  it('puts the debt item first and reports why the rest were dropped', () => {
    const { candidates, rejected } = selectCandidates(
      [
        issue({ number: 1 }),
        issue({ number: 2, title: 'feat(git): implement git clean', body: '', labels: [] }),
        issue({ number: 3, labels: [{ name: 'cosmos-skipped' }] }),
        issue({ number: 4, pull_request: {} }),
      ],
      { now: NOW }
    );
    expect(candidates.map((c) => c.number)).toEqual([1, 2]);
    expect(rejected).toEqual([
      { number: 3, code: 'already-decided', reason: expect.any(String) },
      { number: 4, code: 'pull-request', reason: expect.any(String) },
    ]);
  });

  it('caps at MAX_CANDIDATES_PER_SOURCE and reports the overflow', () => {
    const many = Array.from({ length: 40 }, (_, i) => issue({ number: i + 1 }));
    const { candidates, truncated } = selectCandidates(many, { now: NOW });
    expect(candidates).toHaveLength(CONFIG.MAX_CANDIDATES_PER_SOURCE);
    expect(truncated).toBe(40 - CONFIG.MAX_CANDIDATES_PER_SOURCE);
  });

  it('honours an explicit lower limit and tolerates junk input', () => {
    expect(selectCandidates([issue()], { now: NOW, limit: 0 }).candidates).toHaveLength(0);
    expect(selectCandidates(null, { now: NOW }).candidates).toEqual([]);
  });
});

describe('dispatchBudget', () => {
  it('allows MAX_DISPATCHES_PER_RUN when nothing is in flight', () => {
    expect(dispatchBudget({ openDispatcherPrs: 0 })).toBe(5);
  });

  it('is limited by the headroom under MAX_OPEN_PRS', () => {
    expect(dispatchBudget({ openDispatcherPrs: 7 })).toBe(3);
    expect(dispatchBudget({ openDispatcherPrs: 9 })).toBe(1);
  });

  it('is zero exactly at the ceiling and beyond it', () => {
    expect(dispatchBudget({ openDispatcherPrs: 10 })).toBe(0);
    expect(dispatchBudget({ openDispatcherPrs: 25 })).toBe(0);
  });

  it('accepts overrides and treats junk as zero in flight', () => {
    expect(dispatchBudget({ openDispatcherPrs: 0, maxPerRun: 2 })).toBe(2);
    expect(dispatchBudget({ openDispatcherPrs: 1, maxOpenPrs: 2 })).toBe(1);
    expect(dispatchBudget({ openDispatcherPrs: Number.NaN })).toBe(5);
    expect(dispatchBudget()).toBe(5);
  });
});

describe('issueBranch and isAutomationPr agreement', () => {
  it('names branches under automation/backlog/issue-<n>', () => {
    expect(issueBranch(2155)).toBe('automation/backlog/issue-2155');
    expect(issueBranch('42')).toBe('automation/backlog/issue-42');
  });

  it('produces a branch the PR Fix Dispatcher recognises as automation', () => {
    // If this ever diverges, backlog PRs stop getting their CI failures fixed.
    expect(isAutomationPr({ user: { type: 'User' }, head: { ref: issueBranch(1) } })).toBe(true);
    expect(isAutomationPr({ user: { type: 'User' }, headRef: issueBranch(999) })).toBe(true);
  });
});

describe('isDispatcherPr', () => {
  it('recognises its own branch prefix and its own label', () => {
    expect(isDispatcherPr({ head: { ref: issueBranch(3) } })).toBe(true);
    expect(isDispatcherPr({ headRef: 'feature/x', labels: [{ name: LABELS.dispatched }] })).toBe(
      true
    );
    expect(isDispatcherPr({ headRef: 'feature/x', labels: [{ name: 'cosmos-dispatched' }] })).toBe(
      true
    );
  });

  it('rejects unrelated PRs and junk', () => {
    expect(isDispatcherPr({ headRef: 'renovate/vite-6.x' })).toBe(false);
    expect(isDispatcherPr(null)).toBe(false);
  });
});

describe('selectStalePrs', () => {
  const pr = (overrides = {}) => ({
    number: 500,
    title: 'fix: something',
    state: 'open',
    head: { ref: issueBranch(100) },
    updated_at: daysAgo(9),
    html_url: 'https://github.com/o/r/pull/500',
    labels: [],
    ...overrides,
  });

  it('selects a dispatcher PR idle past the threshold', () => {
    const [stale] = selectStalePrs([pr()], { now: NOW });
    expect(stale).toMatchObject({ number: 500, headRef: issueBranch(100) });
    expect(stale.idleDays).toBeCloseTo(9, 5);
  });

  it('is exclusive at the boundary in the safe direction', () => {
    expect(selectStalePrs([pr({ updated_at: daysAgo(6.9) })], { now: NOW })).toHaveLength(0);
    expect(selectStalePrs([pr({ updated_at: daysAgo(7) })], { now: NOW })).toHaveLength(1);
  });

  it('ignores PRs that are not the dispatcher own', () => {
    expect(selectStalePrs([pr({ head: { ref: 'renovate/x' }, labels: [] })], { now: NOW })).toEqual(
      []
    );
  });

  it('is idempotent: an already-labelled PR is never selected again', () => {
    expect(selectStalePrs([pr({ labels: [{ name: LABELS.stale }] })], { now: NOW })).toEqual([]);
  });

  it('ignores closed PRs and orders oldest-idle first', () => {
    expect(selectStalePrs([pr({ state: 'closed' })], { now: NOW })).toEqual([]);
    const ordered = selectStalePrs(
      [pr({ number: 2, updated_at: daysAgo(8) }), pr({ number: 1, updated_at: daysAgo(20) })],
      { now: NOW }
    );
    expect(ordered.map((p) => p.number)).toEqual([1, 2]);
  });

  it('falls back to created_at and tolerates junk', () => {
    expect(
      selectStalePrs([pr({ updated_at: undefined, created_at: daysAgo(30) })], { now: NOW })
    ).toHaveLength(1);
    expect(selectStalePrs(null, { now: NOW })).toEqual([]);
  });
});

describe('formatSkipComment', () => {
  const body = formatSkipComment('It touches the sudo authorization surface.', {
    runUrl: 'https://github.com/o/r/actions/runs/1',
    issueNumber: 2062,
  });

  it('opens with the 🎫 attribution linking the Actions run', () => {
    expect(body.split('\n')[0]).toBe(
      '<sup>🎫 [Backlog Dispatcher](https://github.com/o/r/actions/runs/1)</sup>'
    );
  });

  it('carries the reason, the re-queue instruction, and the hidden marker', () => {
    expect(body).toContain('It touches the sudo authorization surface.');
    expect(body).toContain(`remove the \`${LABELS.skipped}\` label`);
    expect(body).toContain(buildMarker('skip', 2062));
    expect(buildMarker('skip', 2062)).toBe('<!-- backlog-skip:2062 -->');
  });

  it('degrades to a plain role name with no run URL', () => {
    expect(formatSkipComment('nope', {}).split('\n')[0]).toBe('<sup>🎫 Backlog Dispatcher</sup>');
  });

  it('renders a placeholder issue number verbatim instead of NaN', () => {
    // The triage prompt embeds this template with `<number>` for Claude to fill
    // in; a `Number()` coercion here used to turn that into `backlog-skip:NaN`.
    expect(buildMarker('skip', '<number>')).toBe('<!-- backlog-skip:<number> -->');
    expect(buildMarker('skip', '2062')).toBe('<!-- backlog-skip:2062 -->');
  });

  it('is the single source of the skip format the triage prompt hands Claude', () => {
    // Guards the wiring: if the prompt stopped embedding this builder, the model
    // would invent its own comment shape and the 🎫 header would drift.
    const prompt = buildTriagePrompt([], { repo: 'o/r', runUrl: 'https://run', budget: 2 });
    expect(prompt).toContain('## The skip comment');
    expect(prompt).toContain('<sup>🎫 [Backlog Dispatcher](https://run)</sup>');
    expect(prompt).toContain('<!-- backlog-skip:<number> -->');
    // The label, not the marker, is the dedup key — the prompt must say so.
    expect(prompt).toContain(`The \`${LABELS.skipped}\` label`);
  });
});

describe('formatStaleComment', () => {
  const body = formatStaleComment(
    { number: 501, idleDays: 9.7 },
    { runUrl: 'https://github.com/o/r/actions/runs/2' }
  );

  it('states the idle age, promises never to close, and carries a marker', () => {
    expect(body).toContain('idle for 9 day(s)');
    expect(body).toMatch(/never closes a pull request/i);
    expect(body).toContain(buildMarker('stale', 501));
  });
});

describe('buildTriagePrompt', () => {
  const { candidates } = selectCandidates([issue()], { now: NOW });
  const prompt = buildTriagePrompt(candidates, { repo: 'o/r', budget: 3 });

  it('names the repo, the candidates file, and the budget', () => {
    expect(prompt).toContain('`o/r`');
    expect(prompt).toContain('backlog-candidates.json');
    expect(prompt).toContain('at most **3**');
  });

  it('carries the whole recovered hard-override catalog', () => {
    for (const fragment of [
      'Security / authorization surface',
      'Upstream/platform bug',
      'Cross-cutting redesign',
      'Unconfirmed root cause',
      'Concurrency / data integrity',
      'Native work CI cannot verify',
      'New UX / product surface',
    ]) {
      expect(prompt).toContain(fragment);
    }
  });

  it('forbids code, PRs, closing, and a second comment', () => {
    expect(prompt).toMatch(/do NOT read or write code/i);
    expect(prompt).toMatch(/do NOT\s+open a pull request/i);
    expect(prompt).toMatch(/never close an issue/i);
    expect(prompt).toMatch(/Never post a second comment/i);
  });

  it('renders each candidate with its class, score, and named file', () => {
    expect(prompt).toContain('### #100 —');
    expect(prompt).toContain('Class: `debt`');
    expect(prompt).toContain('session-freezer.ts');
  });

  it('survives an empty candidate list', () => {
    expect(buildTriagePrompt([], { repo: 'o/r' })).toContain('_None._');
  });
});

describe('buildAuthorPrompt', () => {
  const prompt = buildAuthorPrompt([{ number: 100, title: 'Paranoia: swallowed errors' }], {
    repo: 'o/r',
    budget: 2,
  });

  it('lists the issues and the branch convention', () => {
    expect(prompt).toContain('#100 — Paranoia: swallowed errors');
    expect(prompt).toContain('automation/backlog/issue-<number>');
    expect(prompt).toContain('stop after\n2 of them');
  });

  it('requires the Closes line and leaves the dispatched label swap to the workflow', () => {
    expect(prompt).toContain('Closes #<number>');
    expect(prompt).not.toContain(
      `gh issue edit <number> --remove-label ${LABELS.ready} --add-label ${LABELS.dispatched}`
    );
    expect(prompt).toMatch(
      new RegExp(`swaps the\\s+issue's \`${LABELS.ready}\` label for \`${LABELS.dispatched}\``)
    );
  });

  it('pushes the branch and leaves PR creation to the deterministic step', () => {
    // A PR opened by Claude's `gh` is authored by github-actions[bot], and
    // GitHub queues every check on such a PR as `action_required` until a human
    // approves it — so the workflow opens one PR per pushed branch with BOT_PAT,
    // from the per-issue title/body files the brief names here.
    expect(prompt).toContain('git push -u origin automation/backlog/issue-<number>');
    expect(prompt).toContain('$RUNNER_TEMP/backlog-pr-<number>.md');
    expect(prompt).toContain('$PR_BODY_FILE_TEMPLATE');
    expect(prompt).not.toMatch(/^\s*gh pr create/m);
    expect(prompt.match(/gh pr create/g)).toHaveLength(1);
    expect(prompt).toContain('action_required');
  });

  it('forbids closing anything, merging, and gate-dodging', () => {
    expect(prompt).toMatch(/Never close an issue or a pull request/i);
    expect(prompt).toMatch(/never merge/i);
    expect(prompt).toMatch(/Never lower a coverage floor/i);
    expect(prompt).toMatch(/lint suppression/i);
  });

  it('tells it to back out rather than force a PR', () => {
    expect(prompt).toMatch(/open NO pull\s+request/i);
    expect(prompt).toContain(`--add-label ${LABELS.skipped}`);
  });

  it('survives an empty issue list', () => {
    expect(buildAuthorPrompt([], { repo: 'o/r' })).toContain('_None._');
  });
});

describe('buildDigest', () => {
  const { candidates, rejected, truncated } = selectCandidates(
    [issue({ number: 1 }), issue({ number: 2, labels: [{ name: 'cosmos-skipped' }] })],
    { now: NOW }
  );

  it('reports the funnel, the budget, and the never-close policy', () => {
    const digest = buildDigest({
      repo: 'o/r',
      candidates,
      rejected,
      truncated,
      budget: 5,
      openDispatcherPrs: 2,
      stale: [{ number: 9, idleDays: 8.2, headRef: issueBranch(3) }],
    });
    expect(digest).toContain('🎫 Backlog Dispatcher');
    expect(digest).toContain('dispatcher PRs open: **2**/10');
    expect(digest).toContain('| `already-decided` | 1 |');
    expect(digest).toContain('#9 idle 8d');
    expect(digest).toMatch(/never closed/i);
  });

  it('escapes pipes in titles so the table survives', () => {
    const digest = buildDigest({ candidates: [{ ...candidates[0], title: 'a | b' }] });
    expect(digest).toContain('a \\| b');
  });

  it('marks a dry run and survives empty input', () => {
    const digest = buildDigest({ dryRun: true });
    expect(digest).toContain('**DRY RUN**');
    expect(digest).toContain('_no candidates_');
    expect(digest).toContain('_None._');
  });
});
