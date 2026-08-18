/*
 * Backlog Dispatcher — pure logic.
 *
 * Scans the repository's open issues on a schedule, keeps the ones that look
 * ready to be implemented without a human design conversation, and hands them
 * to a PR-authoring Claude phase. It never closes an issue, never closes a pull
 * request, and never merges anything.
 *
 * This module is free of I/O (Node builtins only, no `process.env`, no fetch)
 * so it can be unit-tested in isolation; the GitHub REST calls and the side
 * effects (labels, comments, the composed prompts reaching Actions outputs)
 * live in `select-backlog-issues.mjs` and `sweep-stale-prs.mjs`.
 *
 * READINESS RUBRIC PROVENANCE — the original (Augment Code "Cosmos") expert's
 * prompt body was a `kb://` include that did not survive the platform's
 * retirement. What DID survive is roughly fifty of its decisions, left in this
 * repo as `cosmos-dispatched` / `cosmos-skipped` labels plus its own verbatim
 * skip comments. {@link HARD_OVERRIDES} and {@link READY_CLASSES} below are
 * reconstructed from that record, so the rubric this dispatcher applies is the
 * rubric the previous one demonstrably applied.
 *
 * STATE — GitHub-native, no state file, state branch, or Actions cache. The
 * labels ARE the work queue, and unlike the PR Fix Dispatcher they ARE the
 * dedup key: an issue carrying a decided label is not a candidate at all. That
 * is deliberate and fixes a bug in the original, which re-posted its skip
 * comment on the same issue on every tick. A decision is made once; a human
 * removing the label is the intended, documented way to re-queue an issue.
 *
 * The repository is never hardcoded here — the caller supplies it — so this
 * package can be promoted to a reusable `ai-ecoverse/.github` workflow without
 * a rewrite.
 */

/** Backpressure and eligibility configuration (the Cosmos-era knobs, verbatim). */
export const CONFIG = {
  /** PR-author dispatches per tick. */
  MAX_DISPATCHES_PER_RUN: 5,
  /** Issues kept per tick after screening and ranking. */
  MAX_CANDIDATES_PER_SOURCE: 25,
  /** Dispatcher-owned open PRs allowed in flight at once. */
  MAX_OPEN_PRS: 10,
  /** Minimum issue age before it is eligible — lets the author edit/triage first. */
  SETTLING_AGE_HOURS: 1,
  /** A dispatcher-owned open PR idle this long is swept (labelled, never closed). */
  STALE_PR_DAYS: 7,
};

/**
 * Labels the dispatcher maintains, plus the legacy Cosmos-era names that mean
 * the same thing. ~50 issues in this repo already carry the legacy labels, so
 * treating them as equivalent is what stops the first run from re-proposing
 * work the previous dispatcher already rejected (the sudo-over-tray issue being
 * the obvious example).
 */
export const LABELS = {
  /** Phase 1 marked this ready; phase 2's work queue. */
  ready: 'backlog-ready',
  /** Phase 2 opened a PR for it. */
  dispatched: 'backlog-dispatched',
  /** Decided against, once and for all (until a human removes the label). */
  skipped: 'backlog-skipped',
  /** A dispatcher-owned PR that has gone idle. */
  stale: 'backlog-stale',
  /**
   * The author phase died. Reuses the legacy name deliberately: the label
   * already exists in this repo and means exactly this.
   */
  failed: 'cosmos-dispatch-failed',
  /** Legacy names equivalent to `dispatched`. */
  legacyDispatched: ['cosmos-dispatched'],
  /** Legacy names equivalent to `skipped`. */
  legacySkipped: ['cosmos-skipped'],
  /** Legacy names equivalent to `failed`. */
  legacyFailed: ['cosmos-dispatch-failed'],
};

/**
 * Every label that means "this issue has already been decided". Carrying any of
 * them takes the issue out of the candidate pool.
 */
export const DECIDED_LABELS = [
  LABELS.ready,
  LABELS.dispatched,
  LABELS.skipped,
  LABELS.failed,
  ...LABELS.legacyDispatched,
  ...LABELS.legacySkipped,
  ...LABELS.legacyFailed,
];

/**
 * Labels whose presence says a human has already routed the issue somewhere
 * other than "implement this": a question, a rejected ask, or work explicitly
 * reserved for an outside contributor.
 *
 * `skill issue` is deliberately NOT here, however much it sounds like one.
 * `.github/workflows/issue-skill.yml` applies it to EVERY issue on `opened`, as
 * a joke — so in this repository it means "an issue exists", not "user error".
 * Denying it silently disabled this whole dispatcher: 14 of 17 open items
 * carried it, and every future issue is born with it.
 */
export const DENYLIST_LABELS = ['question', 'wontfix', 'invalid', 'duplicate', 'help wanted'];

/** Colour + description used when bootstrapping labels (`gh label create --force`). */
export const LABEL_META = {
  [LABELS.ready]: {
    color: '0e8a16',
    description: 'Backlog Dispatcher: triage judged this ready for an authored PR',
  },
  [LABELS.dispatched]: {
    color: '1d76db',
    description: 'Backlog Dispatcher: a PR was opened for this issue',
  },
  [LABELS.skipped]: {
    color: 'cccccc',
    description: 'Backlog Dispatcher: decided against dispatching; remove this label to re-queue',
  },
  [LABELS.stale]: {
    color: 'fbca04',
    description: 'Backlog Dispatcher: dispatcher-owned PR has gone idle and needs a human',
  },
  [LABELS.failed]: {
    color: 'b60205',
    description: 'Backlog Dispatcher: the PR author phase did not finish',
  },
};

/** Head-branch prefix for every PR this dispatcher opens. */
export const BRANCH_PREFIX = 'automation/backlog';

/**
 * The hard-override catalog: classes of issue that are never dispatched,
 * whatever they score. Every entry was derived from a real Cosmos skip on this
 * repo; the quoted reason is the shape of its own explanation.
 */
export const HARD_OVERRIDES = [
  {
    id: 'security-surface',
    label: 'Security / authorization surface',
    detail:
      'sudo, approvals, grants, secrets, tokens, CSP, permissions — authorization changes need human review.',
    pattern: /\b(sudo|approval|authoriz|grant|secret|token|csp|permission|credential)\w*/i,
  },
  {
    id: 'platform-bug',
    label: 'Upstream/platform bug or a design call',
    detail:
      'an upstream framework bug, or anything needing on-device experimentation or a design decision, not a localised fix.',
    pattern:
      /\b(upstream|feedback assistant|fb\d{6,}|radar|workaround for|on[- ]device|design (call|decision)|needs? (a )?design)\b/i,
  },
  {
    id: 'architectural',
    label: 'Cross-cutting redesign / architectural scope',
    detail:
      'god-class splits (the "Bloat" sin), transport replacements, runtime redesigns — not one small contained PR.',
    pattern:
      /\b(bloat|redesign|re-?architect|architectur\w*|rewrite|cross-cutting|split .* into|replace the .* (transport|protocol)|fast path)\b/i,
  },
  {
    id: 'unconfirmed-cause',
    label: 'Unconfirmed root cause',
    detail: 'the cause is suspected, not proven — a human must pick the approach first.',
    pattern:
      /\b(unconfirmed|suspected|not reproduc\w+|cannot reproduce|root cause is unknown|unclear (why|cause))\b/i,
  },
  {
    id: 'concurrency',
    label: 'Concurrency / data integrity across layers',
    detail: 'races and corruption spanning service, cache, and protocol behaviour.',
    pattern:
      /\b(race condition|concurren\w+|deadlock|data (integrity|corruption)|locking|atomics|sharedarraybuffer)\b/i,
  },
  {
    id: 'native-unverifiable',
    label: 'Native work CI cannot verify',
    detail: 'iOS/Swift/macOS behaviour that needs a device or a Simulator session to confirm.',
    pattern: /\b(ios-app|ios app|simulator|swiftui|on a device|xcode|notariz\w+|entitlement)\b/i,
  },
  {
    id: 'unspecified-ux',
    label: 'New UX / product surface with no specified behaviour',
    detail: 'the ask names an outcome but not the behaviour; somebody has to design it.',
    pattern:
      /\b(make .* (a )?real concepts?|rethink|explore|proposal|we should probably|some kind of|nice to have)\b/i,
  },
];

/**
 * Signals of the classes the previous dispatcher actually dispatched. Ordered
 * best-first; `base` feeds {@link scoreCandidate}.
 */
export const READY_CLASSES = [
  {
    id: 'debt',
    base: 100,
    labels: ['agentic-debt', 'debt'],
    /** The codebase-sins vocabulary, minus Bloat (a god-class split is architectural). */
    pattern:
      /^(paranoia|necrophilia|entanglement|duplication|complicatification|drift|amnesia|cargo[- ]cult)\b/i,
  },
  { id: 'bug', base: 80, labels: ['bug'], pattern: /^(bug|fix)\(|^flaky test\b/i },
  { id: 'docs', base: 60, labels: ['documentation', 'area/docs'], pattern: /^docs?\(/i },
  { id: 'feat', base: 40, labels: ['enhancement'], pattern: /^(feat|test|chore|refactor)\(/i },
];

/** A path-looking token: `packages/webapp/src/x.ts`, `foo.mjs`, `wc-live.ts`. */
const NAMED_FILE_RE = /[\w./-]+\.(ts|tsx|mjs|js|json|md|swift|go|yml|yaml|sh|grit)\b/;

/** A concrete, observable symptom — the difference between a bug report and a vibe. */
const CONCRETE_SYMPTOM_RE =
  /\b(throws?|error|times? out|hangs?|crashes?|returns? (the )?wrong|is (invisible|ignored|dropped|empty)|swallows?|off[- ]by[- ]one|regress\w*|does not|doesn't|never (fires|runs|resolves))\b/i;

/**
 * Characters of an issue body any regex is allowed to see. The file/symptom
 * patterns backtrack, so an unbounded body (issues here reach tens of KB) turns
 * a scan into a visibly slow one; the signals we look for are always near the
 * top of a well-formed brief anyway.
 */
const MAX_SCANNED_BODY_CHARS = 4000;

/** Milliseconds per hour, for the age arithmetic. */
const HOUR_MS = 3_600_000;

/** Normalise a GitHub label array (strings or `{name}` objects) to lowercase names. */
export function labelNames(issue) {
  const raw = Array.isArray(issue?.labels) ? issue.labels : [];
  return raw
    .map((l) => String(typeof l === 'string' ? l : (l?.name ?? '')).toLowerCase())
    .filter((n) => n.length > 0);
}

/** Hours between two instants; Infinity when `then` is unusable (never blocks on bad data). */
function hoursSince(then, now) {
  const thenMs = new Date(then ?? '').getTime();
  const nowMs = new Date(now ?? Date.now()).getTime();
  if (Number.isNaN(thenMs) || Number.isNaN(nowMs)) return Number.POSITIVE_INFINITY;
  return (nowMs - thenMs) / HOUR_MS;
}

/** Days between two instants; Infinity when `then` is unusable. */
function daysSince(then, now) {
  return hoursSince(then, now) / 24;
}

/** The head branch this dispatcher uses for an issue. */
export function issueBranch(number) {
  return `${BRANCH_PREFIX}/issue-${Number(number)}`;
}

/**
 * Does a PR belong to this dispatcher? True for its own branch prefix or its
 * dispatched label, so a relabelled-but-correctly-named PR is still recognised.
 * @param {{head?: {ref?: string}, headRef?: string, labels?: Array<string|{name?: string}>}} pr
 * @returns {boolean}
 */
export function isDispatcherPr(pr) {
  if (!pr) return false;
  const ref = String(pr.head?.ref ?? pr.headRef ?? '');
  if (ref.startsWith(`${BRANCH_PREFIX}/`)) return true;
  const labels = labelNames(pr);
  return labels.includes(LABELS.dispatched) || labels.includes(LABELS.legacyDispatched[0]);
}

/** Build a regex that matches `#12` but not `#123`. */
function issueRefRe(number) {
  return new RegExp(`#${Number(number)}(?!\\d)`);
}

/**
 * Is there already an open PR in flight for this issue? Matches `Closes #n` /
 * `Fixes #n` / a bare `#n` in the PR body or title, and this dispatcher's own
 * branch name. The Cosmos original skipped #2155 for exactly this reason ("A PR
 * already exists for this ticket (#2156)").
 * @param {{number?: number}} issue
 * @param {Array<{title?: string, body?: string, head?: {ref?: string}, headRef?: string}>} openPrs
 * @returns {boolean}
 */
export function hasLinkedOpenPr(issue, openPrs = []) {
  const number = Number(issue?.number);
  if (!Number.isFinite(number)) return false;
  const branch = issueBranch(number);
  const ref = issueRefRe(number);
  return (Array.isArray(openPrs) ? openPrs : []).some((pr) => {
    const head = String(pr?.head?.ref ?? pr?.headRef ?? '');
    if (head === branch) return true;
    return ref.test(`${String(pr?.title ?? '')}\n${String(pr?.body ?? '')}`);
  });
}

/** A structured screening verdict. */
const reject = (code, reason) => ({ eligible: false, code, reason });
const ACCEPT = { eligible: true, code: 'eligible', reason: 'Passed every screening rule.' };

/** The label-based half of the screen, split out to keep the screen readable. */
function screenLabels(labels) {
  const decided = labels.find((l) => DECIDED_LABELS.includes(l));
  if (decided) {
    return reject(
      'already-decided',
      `Already carries "${decided}" — this dispatcher decides once. Remove the label to re-queue.`
    );
  }
  const denied = labels.find((l) => DENYLIST_LABELS.includes(l));
  if (denied) return reject('denylisted', `Labelled "${denied}" — a human has already routed it.`);
  return null;
}

/**
 * Screen one issue for candidacy. Every rejection carries a machine-readable
 * `code` so the digest and the tests can assert on the rule, not the prose.
 *
 * `targeted: true` is an operator naming one issue on `workflow_dispatch`; it
 * waives ONLY the settling-age wait (there is nobody to yield to when a human
 * points at an issue). Every other rule still applies.
 *
 * @param {object} issue a `GET /issues` item
 * @param {{now?: Date|string, targeted?: boolean, openPrs?: Array<object>}} [opts]
 * @returns {{eligible: boolean, code: string, reason: string}}
 */
export function screenIssue(issue, opts = {}) {
  const { now = new Date(), targeted = false, openPrs = [] } = opts;
  if (!issue || typeof issue !== 'object') return reject('malformed', 'Not an issue object.');
  if (issue.pull_request != null) return reject('pull-request', 'This is a pull request.');
  if (String(issue.state ?? 'open').toLowerCase() !== 'open') {
    return reject('not-open', `Issue is ${issue.state}.`);
  }
  if (issue.assignee != null || (issue.assignees ?? []).length > 0) {
    return reject('assigned', 'Someone is already assigned — leaving it to them.');
  }

  const labelVerdict = screenLabels(labelNames(issue));
  if (labelVerdict) return labelVerdict;

  const age = hoursSince(issue.created_at, now);
  if (!targeted && age < CONFIG.SETTLING_AGE_HOURS) {
    return reject(
      'too-young',
      `Opened ${age.toFixed(1)}h ago (< ${CONFIG.SETTLING_AGE_HOURS}h settling window).`
    );
  }
  if (hasLinkedOpenPr(issue, openPrs)) {
    return reject('pr-in-flight', 'An open pull request already references this issue.');
  }
  return ACCEPT;
}

/** Convenience predicate over {@link screenIssue}. */
export function isCandidate(issue, opts = {}) {
  return screenIssue(issue, opts).eligible;
}

/** Which ready class does this issue look like? Label match beats title match. */
export function classifyIssue(issue) {
  const labels = labelNames(issue);
  const title = String(issue?.title ?? '');
  for (const cls of READY_CLASSES) {
    const byLabel = labels.some((l) => cls.labels.some((c) => l === c || l.startsWith(`${c}:`)));
    if (byLabel || cls.pattern.test(title)) return cls.id;
  }
  return 'other';
}

/** Hard-override ids whose smell shows in an issue's title, body, or labels. */
export function detectSmells(issue) {
  const text = [
    String(issue?.title ?? ''),
    String(issue?.body ?? '').slice(0, MAX_SCANNED_BODY_CHARS),
    labelNames(issue).join(' '),
  ].join('\n');
  return HARD_OVERRIDES.filter((o) => o.pattern.test(text)).map((o) => o.id);
}

/**
 * Rank an issue: higher is better. Ready-class membership dominates; a named
 * file and a concrete symptom are the two signals that separated the previous
 * dispatcher's dispatches from its skips. Long bodies and hard-override smells
 * push an issue down but never disqualify it — this function only ORDERS the
 * pool. The actual go/no-go call is Claude's, in phase 1.
 * @param {object} issue
 * @returns {{score: number, class: string, smells: string[], namedFile: string|null}}
 */
export function scoreCandidate(issue) {
  const cls = classifyIssue(issue);
  const base = READY_CLASSES.find((c) => c.id === cls)?.base ?? 10;
  const title = String(issue?.title ?? '');
  const body = String(issue?.body ?? '');
  const scanned = body.slice(0, MAX_SCANNED_BODY_CHARS);
  const namedFile = (NAMED_FILE_RE.exec(title) ?? NAMED_FILE_RE.exec(scanned))?.[0] ?? null;
  const smells = detectSmells(issue);

  let score = base;
  if (NAMED_FILE_RE.test(title)) score += 20;
  else if (namedFile) score += 10;
  if (CONCRETE_SYMPTOM_RE.test(`${title}\n${scanned}`)) score += 15;
  // A 4,000-char issue is a discussion, not a brief. Capped so a very long body
  // cannot outweigh class membership entirely.
  score -= Math.min(30, Math.floor(body.length / 500) * 3);
  score -= 25 * smells.length;
  return { score, class: cls, smells, namedFile };
}

/** Compact candidate view handed to the prompts and the digest. */
function toCandidate(issue) {
  const ranked = scoreCandidate(issue);
  return {
    number: issue.number,
    title: String(issue.title ?? ''),
    url: issue.html_url ?? null,
    createdAt: issue.created_at ?? null,
    labels: labelNames(issue),
    body: String(issue.body ?? ''),
    ...ranked,
  };
}

/**
 * Screen, rank, and cap the issue list. Ordering is deterministic: score
 * descending, then issue number ascending, so two runs over the same data agree.
 * @param {Array<object>} issues
 * @param {{now?: Date|string, limit?: number, openPrs?: Array<object>, targeted?: boolean}} [opts]
 * @returns {{candidates: Array<object>, rejected: Array<{number: number, code: string, reason: string}>, truncated: number}}
 */
export function selectCandidates(issues, opts = {}) {
  const { limit = CONFIG.MAX_CANDIDATES_PER_SOURCE } = opts;
  const candidates = [];
  const rejected = [];
  for (const issue of Array.isArray(issues) ? issues : []) {
    const verdict = screenIssue(issue, opts);
    if (verdict.eligible) candidates.push(toCandidate(issue));
    else
      rejected.push({ number: issue?.number ?? null, code: verdict.code, reason: verdict.reason });
  }
  candidates.sort((a, b) => b.score - a.score || a.number - b.number);
  const kept = candidates.slice(0, Math.max(0, limit));
  return { candidates: kept, rejected, truncated: candidates.length - kept.length };
}

/**
 * How many dispatches this tick may perform:
 * `min(maxPerRun, maxOpenPrs - openDispatcherPrs)`, floored at 0. At the
 * ceiling the answer is 0 — the dispatcher stops adding review load instead of
 * closing something to make room.
 * @param {{openDispatcherPrs?: number, maxOpenPrs?: number, maxPerRun?: number}} [input]
 * @returns {number}
 */
export function dispatchBudget(input = {}) {
  const {
    openDispatcherPrs = 0,
    maxOpenPrs = CONFIG.MAX_OPEN_PRS,
    maxPerRun = CONFIG.MAX_DISPATCHES_PER_RUN,
  } = input;
  const headroom = maxOpenPrs - Math.max(0, Number(openDispatcherPrs) || 0);
  return Math.max(0, Math.min(maxPerRun, headroom));
}

/**
 * Dispatcher-owned open PRs that have gone idle. Already-labelled ones are
 * excluded: the sweep decides once and never re-comments.
 * @param {Array<object>} prs open pull requests
 * @param {{now?: Date|string, staleDays?: number}} [opts]
 * @returns {Array<{number: number, title: string, headRef: string, idleDays: number, url: string|null}>}
 */
export function selectStalePrs(prs, opts = {}) {
  const { now = new Date(), staleDays = CONFIG.STALE_PR_DAYS } = opts;
  return (Array.isArray(prs) ? prs : [])
    .filter((pr) => isDispatcherPr(pr))
    .filter((pr) => String(pr.state ?? 'open').toLowerCase() === 'open')
    .filter((pr) => !labelNames(pr).includes(LABELS.stale))
    .map((pr) => ({
      number: pr.number,
      title: String(pr.title ?? ''),
      headRef: String(pr.head?.ref ?? pr.headRef ?? ''),
      url: pr.html_url ?? null,
      idleDays: daysSince(pr.updated_at ?? pr.created_at, now),
    }))
    .filter((pr) => pr.idleDays >= staleDays)
    .sort((a, b) => b.idleDays - a.idleDays || a.number - b.number);
}

/** The hidden marker every dispatcher comment carries, for durable dedup. */
export function buildMarker(kind, number) {
  // Non-numeric input is passed through verbatim so prompts can render the
  // marker with a `<number>` placeholder instead of a bogus `NaN`.
  const parsed = Number(number);
  return `<!-- backlog-${kind}:${Number.isFinite(parsed) ? parsed : String(number)} -->`;
}

/** The `<sup>` attribution line every comment opens with (Cosmos header convention). */
function attribution(runUrl) {
  const link = runUrl ? `[Backlog Dispatcher](${runUrl})` : 'Backlog Dispatcher';
  return `<sup>🎫 ${link}</sup>`;
}

/**
 * The one comment a skipped issue gets, ever.
 * @param {string} reason plain-language explanation
 * @param {{runUrl?: string, issueNumber?: number}} ctx
 * @returns {string}
 */
export function formatSkipComment(reason, ctx = {}) {
  return [
    attribution(ctx.runUrl),
    '',
    `**Not dispatching this one.** ${reason}`,
    '',
    `Nothing was changed and no pull request was opened. This decision is made once — remove the \`${LABELS.skipped}\` label to put the issue back in the queue.`,
    buildMarker('skip', ctx.issueNumber ?? 0),
  ].join('\n');
}

/**
 * The comment a stale dispatcher PR gets, ever. Explicitly promises not to
 * close: the sweep labels and comments only.
 * @param {{number: number, idleDays: number}} pr
 * @param {{runUrl?: string}} ctx
 * @returns {string}
 */
export function formatStaleComment(pr, ctx = {}) {
  return [
    attribution(ctx.runUrl),
    '',
    `**This dispatcher-owned PR has been idle for ${Math.floor(pr.idleDays)} day(s)** (threshold ${CONFIG.STALE_PR_DAYS}).`,
    '',
    `It is labelled \`${LABELS.stale}\` so a human can pick it up — merge it, take it over, or close it. **This sweep never closes a pull request**, and it will not comment on this PR again.`,
    buildMarker('stale', pr.number),
  ].join('\n');
}

/** One candidate rendered for a prompt. Bodies are truncated; briefs, not novels. */
function candidateBlock(candidate, maxBody = 1200) {
  const body = candidate.body.trim().slice(0, maxBody) || '_(empty body)_';
  const smells = candidate.smells.length ? candidate.smells.join(', ') : 'none detected';
  return [
    `### #${candidate.number} — ${candidate.title}`,
    `Class: \`${candidate.class}\` · score ${candidate.score} · labels: ${candidate.labels.join(', ') || 'none'}`,
    `Named file: ${candidate.namedFile ?? 'none in the title/body'} · hard-override smells: ${smells}`,
    '',
    body,
    '',
  ].join('\n');
}

/** The shared rubric text, so triage and authoring cannot drift apart. */
function rubricSection() {
  const overrides = HARD_OVERRIDES.map((o) => `- **${o.label}** — ${o.detail}`).join('\n');
  return `## Hard overrides — NEVER mark these ready

${overrides}

These are not heuristics; each one is a class the previous dispatcher explicitly
refused on this repository. When an issue matches one, skip it and say which.

## What "ready" looks like

An issue is ready when a competent engineer could open the PR today without
asking anybody a question:

- an agentic-debt item naming both the sin and the file it lives in;
- a small, localised bug with a concrete, observable symptom;
- a missing shell command or flag with a clear spec, or a spec bug in one;
- one named flaky test;
- documentation drift where the stale file is named;
- a narrow test addition.

The change must be verifiable by CI in this repository. If it needs a device, a
Simulator, a design decision, a dependency change, or a conversation, it is not
ready.`;
}

/**
 * Phase 1 prompt: judge each candidate and label the ready ones.
 * @param {Array<object>} candidates from {@link selectCandidates}
 * @param {{repo: string, runUrl?: string, budget?: number}} ctx
 * @returns {string}
 */
export function buildTriagePrompt(candidates = [], ctx = {}) {
  const budget = Number(ctx.budget ?? CONFIG.MAX_DISPATCHES_PER_RUN);
  return `# Backlog triage — is this issue ready to implement?

You are the 🎫 **Backlog Dispatcher** for \`${ctx.repo ?? 'this repository'}\`. A
deterministic selector already screened the open issues (dropping pull requests,
assigned issues, issues younger than ${CONFIG.SETTLING_AGE_HOURS}h, issues with a
PR already in flight, and every issue that was already decided) and wrote the
survivors to \`backlog-candidates.json\` in the repo root. They are listed below
in the same order, best-first.

Your job in this phase is **judgement only**: decide which candidates are ready
and label them. Do NOT read or write code, do NOT create a branch, and do NOT
open a pull request — a later phase does that for at most **${budget}** issue(s)
this run.

${rubricSection()}

## What to do per candidate, in order

1. Read the issue. Investigate the codebase with Read/Grep/Glob to confirm the
   named file exists and the change really is as contained as the issue implies.
2. If it is ready: \`gh issue edit <number> --add-label ${LABELS.ready}\`. Add no
   comment — the PR itself will be the announcement.
3. If it is not ready: \`gh issue edit <number> --add-label ${LABELS.skipped}\` and
   post exactly ONE comment in the format given under "The skip comment" below.
   Never post a second comment on an issue that already has one; the selector
   guarantees you are seeing each issue for the first time.
4. Mark at most **${budget}** issue(s) \`${LABELS.ready}\`. Spend that budget on
   the ones you are most confident about, best-first. Leave the rest completely
   untouched — no label, no comment — so a later run reconsiders them.

Never close an issue, never assign anybody, never edit an issue's title or body,
and never remove a label a human added. Being wrong is more expensive than being
slow: when a candidate is borderline, skip it and explain.

## The skip comment

Post it verbatim in this shape, replacing the reason sentence and \`<number>\`
with the issue's number. The \`${LABELS.skipped}\` label — not the trailing marker
— is what stops a later run reconsidering the issue, so the label edit is the
part you must not skip; the marker is a machine-readable record of which run
decided, and belongs on its own line:

\`\`\`markdown
${formatSkipComment('<one sentence naming the hard override or the missing precondition that decided it>', { runUrl: ctx.runUrl, issueNumber: '<number>' })}
\`\`\`

## Candidates (${candidates.length})

${candidates.map((c) => candidateBlock(c)).join('\n') || '_None._'}

End by printing a short table of what you marked ready and what you skipped,
with the deciding reason for each.`;
}

/**
 * Phase 2 prompt: implement the ready issues and open the PRs.
 * @param {Array<{number: number, title: string}>} issues the `backlog-ready` issues
 * @param {{repo: string, runUrl?: string, budget?: number}} ctx
 * @returns {string}
 */
export function buildAuthorPrompt(issues = [], ctx = {}) {
  const list =
    issues.map((i) => `- #${i.number} — ${String(i.title ?? '')}`).join('\n') || '_None._';
  return `# Backlog PR author

You are the 🎫 **Backlog Dispatcher**'s authoring phase for
\`${ctx.repo ?? 'this repository'}\`. An earlier phase judged the issues below
ready: small, contained, and verifiable by CI in this repository. They were also
written to \`backlog-ready-issues.json\` in the repo root with their full bodies.

${list}

Work them **one at a time**, in the order given, and stop after
${Number(ctx.budget ?? CONFIG.MAX_DISPATCHES_PER_RUN)} of them.

## Per issue

1. PREFLIGHT (idempotency — before creating anything): check for work already in
   flight from an interrupted run:
   \`gh pr list --state open --search "<number> in:body" --json number,headRefName\`
   and \`git ls-remote --exit-code --heads origin ${BRANCH_PREFIX}/issue-<number>\`.
   If either exists, do NOT create a second branch or PR — just reconcile the
   labels (step 5) and move on.
2. \`git switch -c ${BRANCH_PREFIX}/issue-<number>\` off the default branch and
   implement the **minimal** change the issue asks for. Nothing else: no
   drive-by refactors, no dependency changes, no CI-config changes, no
   reformatting of untouched code.
3. Add or update focused tests (\`packages/*/tests/\` mirroring \`src/\`; see
   \`.agents/skills/writing-slicc-tests/SKILL.md\`). Never lower a coverage floor
   or add a lint suppression, an exemption, or a baseline entry to pass a gate.
4. Verify before pushing, per
   \`.agents/skills/verifying-before-push/SKILL.md\`:
   \`\`\`bash
   npx biome check --write <files you touched>
   npm run typecheck
   npx vitest run <the focused test files>
   node packages/dev-tools/tools/check-touched-exemptions.mjs origin/main
   \`\`\`
5. Push the branch and write the PR body to
   \`$RUNNER_TEMP/backlog-pr-<number>.md\` (the pattern is also in
   \`$PR_BODY_FILE_TEMPLATE\`), plus the one-line conventional-commit PR title to
   \`$RUNNER_TEMP/backlog-pr-<number>.title\`:
   \`\`\`bash
   git push -u origin ${BRANCH_PREFIX}/issue-<number>
   printf '%s\\n' "<conventional-commit title>" > "$RUNNER_TEMP/backlog-pr-<number>.title"
   cat > "$RUNNER_TEMP/backlog-pr-<number>.md" <<'EOF'
   Closes #<number>

   <what changed, why, how you verified>
   EOF
   \`\`\`
   The \`Closes #<number>\` line is required — it is how merging the PR closes the
   issue.
6. **Do NOT run \`gh pr create\`, and do not label the issue \`${LABELS.dispatched}\`.**
   A later, deterministic workflow step opens one PR per pushed branch from those
   files, applies the \`${LABELS.dispatched}\` label to the PR (that label is how the
   PR Fix Dispatcher and the stale sweep recognise it as ours), and swaps the
   issue's \`${LABELS.ready}\` label for \`${LABELS.dispatched}\`. The PR must be
   authored by a token whose events trigger CI: a PR opened by your \`gh\` is
   authored by \`github-actions[bot]\`, and GitHub then queues every check on it as
   \`action_required\` until a human clicks "Approve and run". If you push nothing
   for an issue, that step is a clean no-op for it and the issue keeps its
   \`${LABELS.ready}\` label for the next run.

## If it turns out not to be ready

If the change is larger than the issue implied, needs a design decision, touches
a security/authorization surface, or cannot be verified by CI here: open NO pull
request, leave the working tree clean (\`git checkout -- .\`), swap the label
(\`gh issue edit <number> --remove-label ${LABELS.ready} --add-label ${LABELS.skipped}\`),
and post ONE comment explaining what you found. A wrong PR is worse than none.

Never close an issue or a pull request, never merge, never request reviewers, and
never force-push over somebody else's branch. End by printing each issue number
with its PR URL or the reason you left it alone.`;
}

/** One digest row per rejection code, so the summary explains the funnel. */
function rejectionTally(rejected) {
  const counts = new Map();
  for (const r of rejected) counts.set(r.code, (counts.get(r.code) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([code, n]) => `| \`${code}\` | ${n} |`)
    .join('\n');
}

/**
 * The Actions step summary.
 * @param {{repo?: string, candidates?: Array<object>, rejected?: Array<object>, budget?: number, openDispatcherPrs?: number, stale?: Array<object>, truncated?: number, dryRun?: boolean}} input
 * @returns {string}
 */
export function buildDigest(input = {}) {
  const {
    repo = '',
    candidates = [],
    rejected = [],
    budget = 0,
    openDispatcherPrs = 0,
    stale = [],
    truncated = 0,
    dryRun = false,
  } = input;
  const rows =
    candidates
      .map(
        (c) =>
          `| #${c.number} | ${c.title.replaceAll('|', '\\|')} | \`${c.class}\` | ${c.score} | ${c.smells.join(', ') || '—'} |`
      )
      .join('\n') || '| — | _no candidates_ | | | |';

  return `## 🎫 Backlog Dispatcher${dryRun ? ' — **DRY RUN**' : ''}

Repository: \`${repo}\` · candidates: **${candidates.length}**${truncated > 0 ? ` (+${truncated} over the cap of ${CONFIG.MAX_CANDIDATES_PER_SOURCE})` : ''} · dispatcher PRs open: **${openDispatcherPrs}**/${CONFIG.MAX_OPEN_PRS} · dispatch budget: **${budget}**

| Issue | Title | Class | Score | Hard-override smells |
| --- | --- | --- | --- | --- |
${rows}

### Screened out (${rejected.length})

| Reason code | Count |
| --- | --- |
${rejectionTally(rejected) || '| — | 0 |'}

### Stale dispatcher PRs (${stale.length})

${stale.map((p) => `- #${p.number} idle ${Math.floor(p.idleDays)}d — \`${p.headRef}\``).join('\n') || '_None._'}

A stale PR is labelled \`${LABELS.stale}\` and commented on once. It is never closed.`;
}
