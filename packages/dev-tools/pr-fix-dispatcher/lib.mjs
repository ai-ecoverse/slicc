/*
 * PR Fix Dispatcher — pure logic.
 *
 * Triage for routine, automation-authored pull requests whose CI is failing.
 * Every tick the dispatcher picks one of three paths per PR: re-run the failed
 * jobs (the failure is CI plumbing), dispatch a fixer (the failure is in the
 * code and is a small, mechanical fix), or skip. It never edits code, never
 * pushes, and never merges.
 *
 * This module is free of I/O so it can be unit-tested in isolation; the GitHub
 * REST calls and the side effects (re-runs, labels, comments) live in
 * `scan-failing-prs.mjs`.
 *
 * Cross-run state is GitHub-native — there is no state file, state branch, or
 * Actions cache:
 *   • "this SHA was already re-run"   → any workflow run for the head SHA has
 *                                       `run_attempt > 1` (a re-run bumps it).
 *   • "this SHA was already skipped"  → a `<!-- pr-fix-skip:<sha> -->` marker
 *                                       comment on the PR.
 *   • "how many dispatches so far"    → count of `<!-- pr-fix-dispatch:<sha> -->`
 *                                       marker comments on the PR.
 *   • "how many fixes are open"       → open PRs carrying the dispatched label
 *                                       whose head SHA is currently failing.
 * Labels are human-visible markers only and are deliberately NOT the dedup key:
 * an operator relabelling a PR must not change dispatcher behaviour.
 */

/** Backpressure and eligibility configuration (the Cosmos-era knobs). */
export const CONFIG = {
  /** Fixers launched per tick. */
  MAX_DISPATCHES_PER_RUN: 3,
  /** Open PRs pulled from the API per tick. */
  MAX_CANDIDATES: 50,
  /** Dispatcher-owned fixes that may be in flight at once. */
  MAX_OPEN_FIXES: 5,
  /** Dispatches per PR before it is left for a human. */
  MAX_ATTEMPTS_PER_PR: 2,
  /** Re-runs per head SHA, ever. A second failure of the same SHA is not a flake. */
  MAX_RERUNS_PER_SHA: 1,
  /** Minimum age of the failing conclusion, so the repo's own reconcilers go first. */
  SETTLING_MINUTES: 20,
  /** A human comment/review/push this recent means a human is on it. */
  HUMAN_ACTIVITY_MINUTES: 60,
};

/** Human-visible labels the dispatcher maintains. */
export const LABELS = {
  dispatched: 'ci-fix-dispatched',
  skipped: 'ci-fix-skipped',
  failed: 'ci-fix-failed',
};

/** Colours used when bootstrapping the labels (`gh label create --force`). */
export const LABEL_COLORS = {
  [LABELS.dispatched]: '1d76db',
  [LABELS.skipped]: 'cccccc',
  [LABELS.failed]: 'b60205',
};

/**
 * Head-branch prefixes that mark a PR as machine-authored. The branch test
 * matters because this repo opens some automation PRs with a bot PAT, so they
 * carry a human `user.login` while still being machine-authored.
 */
export const AUTOMATION_BRANCH_PREFIXES = ['automation/', 'renovate/', 'rum-fix/'];

/**
 * Labels whose PRs this repo already self-heals through
 * `renovate-patch-reconcile.yml` / `renovate-format-reconcile.yml`. Acting on
 * them would race those workflows.
 */
export const SELF_HEALING_LABELS = ['patched-dependency', 'formatter-bump'];

/** Check-run conclusions that count as a failure. */
export const FAILING_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled']);

/** Commit-status states that count as a failure. */
export const FAILING_STATUS_STATES = new Set(['failure', 'error']);

/** Check-run statuses that mean "not done yet". */
const PENDING_CHECK_STATUSES = new Set([
  'queued',
  'in_progress',
  'waiting',
  'requested',
  'pending',
]);

/**
 * Failure signatures that are hard overrides to the skip path: no re-run can
 * help and no fixer should touch them. Checked before everything else.
 */
export const HARD_SKIP_SIGNATURES = [
  {
    category: 'auth',
    pattern:
      /bad credentials|authentication failed|not authorized|unauthorized|invalid[ _-]?api[ _-]?key|could not read username|permission to .+ denied|resource not accessible by integration/i,
  },
  {
    category: 'expired-token',
    pattern: /token (has )?expired|expired token|credentials? (have|has) expired|refresh token/i,
  },
  {
    category: 'quota',
    pattern:
      /quota (exceeded|exhausted)|exceeded your quota|insufficient[_ ]quota|billing|payment required|rate limit exceeded|too many requests/i,
  },
  {
    category: 'secrets',
    pattern:
      /missing (required )?secret|secrets\.[A-Z_]+ is (empty|unset)|credential helper|gpg (signing|failed)|private key|signing identity/i,
  },
  {
    category: 'schema-migration',
    pattern:
      /schema migration|migration failed|failed to migrate|alter table|drizzle-kit|prisma migrate/i,
  },
  {
    category: 'release',
    pattern:
      /npm publish|semantic-release|wrangler deploy|gh release|notariz|codesign|publish failed|release job/i,
  },
  {
    category: 'dependency-change',
    pattern:
      /ERESOLVE|unable to resolve dependency tree|no matching version found|peer dep|requires a peer of|engine node is incompatible/i,
  },
  {
    category: 'ci-config-change',
    pattern:
      /invalid workflow file|\.github\/workflows\/[\w.-]+\.ya?ml.*(error|invalid)|workflow is not valid/i,
  },
];

/**
 * Job names that are hard overrides to the skip path regardless of the log.
 * A failing release/deploy/publish job is never a routine branch fix.
 */
export const HARD_SKIP_JOB_PATTERN =
  /\b(release|publish|deploy|notariz|provision|migrate|migration|secrets?)\b/i;

/**
 * Failures that did not evaluate the code — CI plumbing. These take the re-run
 * path (once per head SHA).
 *
 * Network patterns deliberately omit a bare `dns` substring: every Actions job
 * in this repo dumps `NODE_OPTIONS: --dns-result-order=ipv4first` into its log,
 * and the `CI / ci` aggregator's script-echo + env dump puts that line inside
 * the log excerpt of `##[error]One or more jobs failed…`. Matching bare `dns`
 * classified PR #2320's real SPM pin conflict as a network flake (re-run once,
 * then skip) and never dispatched a fixer. Real DNS failures still match via
 * `getaddrinfo`, `ENOTFOUND`, `EAI_AGAIN`, or an explicit "dns resolution /
 * lookup / error" phrase.
 */
export const INFRA_SIGNATURES = [
  {
    category: 'artifact',
    pattern:
      /artifact (upload|download)|failed to (upload|download) artifact|actions\/(upload|download)-artifact|unable to (upload|download) artifact/i,
  },
  {
    category: 'network',
    pattern:
      /ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|getaddrinfo|connection reset by peer|tls handshake|dns (resolution|lookup|error)|name resolution/i,
  },
  {
    category: 'registry',
    pattern:
      /registry\.npmjs\.org|npm ERR! network|ERR_SOCKET_TIMEOUT|idealTree|502 bad gateway|503 service unavailable|504 gateway time|remote end hung up/i,
  },
  {
    category: 'runner',
    pattern:
      /runner has received a shutdown signal|lost communication with the server|the runner has been (shut ?down|cancel)|received request to deprovision|exit code 143/i,
  },
  {
    category: 'cancelled',
    pattern: /the operation was canceled|the job was canceled/i,
  },
];

/**
 * Failures that are in the code and look like something a competent engineer
 * fixes on the branch without a design conversation. These take the dispatch
 * path. Evaluated BEFORE {@link INFRA_SIGNATURES} so a concrete assertion or
 * compile error outranks a generic "the operation was canceled" line — that is
 * the rubric's "canceled with no preceding assertion failure" rule.
 */
export const CODE_SIGNATURES = [
  // First, because it is this repo's single most likely automation-PR failure and
  // its output never says "biome", "lint error", or anything else the broader
  // `lint` entry below looks for. The boy-scout and backlog dispatchers edit
  // debt-listed files by design, so `check-touched-exemptions.mjs` — which fails
  // a PR that touches a file still on ANY debt list (function size, cognitive
  // complexity, floating/misused promises, layer back-edges, untyped
  // string-keyed bags) — is exactly the gate they trip. Matches both the
  // touched-file variant and the "list must not grow" variant.
  {
    category: 'debt-gate',
    pattern:
      // The rule label is matched loosely on purpose. Every label today is a
      // single hyphenated token, so `[\w-]+` would do — but this whole class of
      // failure was invisible for exactly one reason: a phrase the classifier
      // expected did not match the phrase the gate printed, and the symptom was
      // silence rather than an error. A label gaining a space should not be able
      // to re-create that.
      /check-touched-exemptions:\s*FAIL|still on the .{1,40}? debt list|debt list is frozen and must not grow/i,
  },
  {
    category: 'lint',
    pattern: /biome (found|check)|eslint|prettier|lint(ing)? (error|failed)|format(ter)? would/i,
  },
  {
    category: 'types',
    pattern:
      /error TS\d+|typecheck failed|is not assignable to|tsc --noEmit|has no exported member/i,
  },
  {
    category: 'tests',
    pattern:
      /assertionerror|\d+ (test|spec)s? failed|tests? failed|test files\s+\d+ failed|expected .+ (to|but) |unhandled error in test/i,
  },
  {
    category: 'snapshot-or-threshold',
    pattern:
      /snapshot|tomatchsnapshot|obsolete snapshot|below (the )?configured minimum coverage|coverage .*below|does not meet (the )?threshold/i,
  },
  {
    category: 'generated-artifact',
    pattern:
      /package-lock\.json|lock ?file (is )?out of (sync|date)|npm ci can only install|git diff --exit-code|generated file .* out of date|working tree is dirty/i,
  },
  // Renovate updates Package.swift / Package.resolved but historically missed
  // the sibling xcodegen `project.yml` `exactVersion:` pins (PR #2320). SPM
  // then fails with a version conflict that is a mechanical pin sync, not a
  // design decision and not CI plumbing.
  {
    category: 'pin-sync',
    pattern:
      /could not resolve package dependencies|dependencies could not be resolved because|depends on ['"]?[\w.-]+['"]? [\d.]+(?:\.\.<[\d.]+)? and .+ depends on ['"]?[\w.-]+['"]? [\d.]+/i,
  },
  {
    category: 'merge-conflict',
    pattern:
      /merge conflict|CONFLICT \(content\)|automatic merge failed|cannot be automatically merged|refusing to merge unrelated histories/i,
  },
  {
    category: 'build',
    pattern: /build failed|error during build|rollup failed|vite build|compilation (error|failed)/i,
  },
];

/**
 * Does this PR qualify as routine automation? True when the author is a bot OR
 * the head branch carries a known automation prefix.
 * @param {{user?: {type?: string, login?: string}, head?: {ref?: string}, headRef?: string}} pr
 * @returns {boolean}
 */
export function isAutomationPr(pr) {
  if (!pr) return false;
  const authorType = String(pr.user?.type ?? '').toLowerCase();
  if (authorType === 'bot') return true;
  const ref = String(pr.head?.ref ?? pr.headRef ?? '');
  return AUTOMATION_BRANCH_PREFIXES.some((prefix) => ref.startsWith(prefix));
}

/** Fold `GET /commits/{sha}/check-runs` into failing entries plus a pending flag. */
function foldCheckRuns(checkRuns) {
  const failing = [];
  let pending = false;
  for (const run of Array.isArray(checkRuns) ? checkRuns : []) {
    const status = String(run?.status ?? '').toLowerCase();
    const conclusion = String(run?.conclusion ?? '').toLowerCase();
    if (PENDING_CHECK_STATUSES.has(status) || (status !== 'completed' && !conclusion)) {
      pending = true;
      continue;
    }
    if (FAILING_CONCLUSIONS.has(conclusion)) {
      failing.push({
        name: String(run?.name ?? 'unknown check'),
        conclusion,
        completedAt: run?.completed_at ?? run?.started_at ?? null,
        detailsUrl: run?.details_url ?? null,
        kind: 'check-run',
      });
    }
  }
  return { failing, pending };
}

/** Fold `GET /commits/{sha}/status` into failing entries plus a pending flag. */
function foldStatuses(statuses) {
  const failing = [];
  let pending = false;
  for (const status of Array.isArray(statuses) ? statuses : []) {
    const state = String(status?.state ?? '').toLowerCase();
    if (state === 'pending') {
      pending = true;
      continue;
    }
    if (FAILING_STATUS_STATES.has(state)) {
      failing.push({
        name: String(status?.context ?? 'unknown status'),
        conclusion: state,
        completedAt: status?.updated_at ?? status?.created_at ?? null,
        detailsUrl: status?.target_url ?? null,
        kind: 'status',
        description: status?.description ?? '',
      });
    }
  }
  return { failing, pending };
}

/**
 * Fold check-runs and commit statuses into one CI verdict.
 * @param {{checkRuns?: Array<object>, statuses?: Array<object>}} input
 *   `checkRuns` from `GET /commits/{sha}/check-runs` (`.check_runs`),
 *   `statuses` from `GET /commits/{sha}/status` (`.statuses`).
 * @returns {{failing: Array<{name: string, conclusion: string, completedAt: string|null, detailsUrl: string|null, kind: 'check-run'|'status'}>, pending: boolean, newestFailureAt: string|null}}
 */
export function summarizeChecks({ checkRuns = [], statuses = [] } = {}) {
  const fromRuns = foldCheckRuns(checkRuns);
  const fromStatuses = foldStatuses(statuses);
  const failing = [...fromRuns.failing, ...fromStatuses.failing];
  const pending = fromRuns.pending || fromStatuses.pending;

  const newestFailureAt =
    failing
      .map((f) => f.completedAt)
      .filter(Boolean)
      .sort()
      .pop() ?? null;

  return { failing, pending, newestFailureAt };
}

/** First matching signature in a table, or null. */
function matchSignature(table, text) {
  for (const entry of table) {
    if (entry.pattern.test(text)) return entry.category;
  }
  return null;
}

/**
 * The `CI / ci` aggregator (`if: always()` over `needs: [*]`) always fails
 * whenever any child does; its own log only echoes that fact (plus the job
 * env dump). Classifying it from its log would let boilerplate — or a false
 * infra hit inside that dump — dominate a sibling that named the real cause.
 * @param {string} jobName
 * @param {string} logExcerpt
 * @returns {boolean}
 */
function isCiAggregatorNoise(jobName, logExcerpt) {
  if (String(jobName).toLowerCase() !== 'ci') return false;
  return /one or more jobs failed or were cancelled/i.test(String(logExcerpt));
}

/**
 * Classify a single failure as infrastructure, code, blocked (hard skip), or
 * unknown, from its job name plus a log excerpt.
 * @param {{jobName?: string, logExcerpt?: string}} failure
 * @returns {{kind: 'blocked'|'code'|'infra'|'unknown', category: string|null, reason: string}}
 */
export function classifyFailure({ jobName = '', logExcerpt = '' } = {}) {
  const name = String(jobName);
  const text = `${name}\n${String(logExcerpt)}`;

  // Aggregator boilerplate never names a cause — treat as unknown so a sibling
  // with a real signature can win in {@link classifyFailures}.
  if (isCiAggregatorNoise(name, logExcerpt)) {
    return {
      kind: 'unknown',
      category: null,
      reason: `"${name}" is the CI aggregator and does not name a failure cause.`,
    };
  }

  if (HARD_SKIP_JOB_PATTERN.test(name)) {
    return {
      kind: 'blocked',
      category: 'sensitive-job',
      reason: `"${name}" is a release/deploy/secrets-class job — out of scope for an automated fix.`,
    };
  }
  const blocked = matchSignature(HARD_SKIP_SIGNATURES, text);
  if (blocked) {
    return {
      kind: 'blocked',
      category: blocked,
      reason: `"${name}" failed on ${blocked} — a hard-override category no automated path can fix.`,
    };
  }
  const code = matchSignature(CODE_SIGNATURES, text);
  if (code) {
    return {
      kind: 'code',
      category: code,
      reason: `"${name}" failed in the code (${code}).`,
    };
  }
  const infra = matchSignature(INFRA_SIGNATURES, text);
  if (infra) {
    return {
      kind: 'infra',
      category: infra,
      reason: `"${name}" failed in CI plumbing (${infra}) without evaluating the code.`,
    };
  }
  return {
    kind: 'unknown',
    category: null,
    reason: `"${name}" failed but no plausible cause could be named from its log.`,
  };
}

/**
 * Fold per-failure classifications into one verdict for the PR. `blocked`
 * dominates, then `code` (fix it), then `infra` (re-run it); `unknown` only
 * when nothing else matched.
 * @param {Array<{name?: string, jobName?: string, logExcerpt?: string}>} failures
 * @returns {{kind: 'blocked'|'code'|'infra'|'unknown', category: string|null, reason: string}}
 */
export function classifyFailures(failures = []) {
  const classified = (Array.isArray(failures) ? failures : []).map((f) =>
    classifyFailure({
      jobName: f.jobName ?? f.name,
      logExcerpt: f.logExcerpt ?? f.description ?? '',
    })
  );
  for (const kind of ['blocked', 'code', 'infra']) {
    const hit = classified.find((c) => c.kind === kind);
    if (hit) return hit;
  }
  return (
    classified[0] ?? {
      kind: 'unknown',
      category: null,
      reason: 'No failing job could be named.',
    }
  );
}

/** Durable marker comment recording that this head SHA was skipped. */
export function buildSkipMarker(sha) {
  return `<!-- pr-fix-skip:${sha} -->`;
}

/** Durable marker comment recording that this head SHA was dispatched to a fixer. */
export function buildDispatchMarker(sha) {
  return `<!-- pr-fix-dispatch:${sha} -->`;
}

const SKIP_MARKER_RE = /<!--\s*pr-fix-skip:([0-9a-f]{7,40})\s*-->/gi;
const DISPATCH_MARKER_RE = /<!--\s*pr-fix-dispatch:([0-9a-f]{7,40})\s*-->/gi;

/**
 * Extract the dispatcher's durable state from a PR's issue comments.
 * `dispatchedShas` keeps duplicates out but `attempts` counts markers, so a
 * re-dispatch onto a *new* SHA increments attempts while a repeated marker for
 * the same SHA does not inflate it.
 * @param {Array<{body?: string}>} comments
 * @returns {{skippedShas: Set<string>, dispatchedShas: Set<string>, attempts: number}}
 */
export function parseMarkers(comments = []) {
  const skippedShas = new Set();
  const dispatchedShas = new Set();
  for (const comment of Array.isArray(comments) ? comments : []) {
    const body = String(comment?.body ?? '');
    for (const [, sha] of body.matchAll(SKIP_MARKER_RE)) skippedShas.add(sha.toLowerCase());
    for (const [, sha] of body.matchAll(DISPATCH_MARKER_RE)) dispatchedShas.add(sha.toLowerCase());
  }
  return { skippedShas, dispatchedShas, attempts: dispatchedShas.size };
}

/**
 * Was this head SHA already re-run? A re-run bumps `run_attempt`, so any run
 * for the SHA with `run_attempt > 1` is proof — no stored state needed.
 * @param {Array<{run_attempt?: number}>} runs from `GET /actions/runs?head_sha=<sha>`
 * @returns {boolean}
 */
export function hasRerunForSha(runs = []) {
  return (Array.isArray(runs) ? runs : []).some(
    (run) => Number(run?.run_attempt ?? 1) > CONFIG.MAX_RERUNS_PER_SHA
  );
}

/**
 * How many fixers may be dispatched this tick:
 * `min(MAX_DISPATCHES_PER_RUN, MAX_OPEN_FIXES - openFixes)`, floored at 0.
 * @param {{openFixes?: number}} input
 * @returns {number}
 */
export function dispatchBudget({ openFixes = 0 } = {}) {
  const headroom = CONFIG.MAX_OPEN_FIXES - Math.max(0, Number(openFixes) || 0);
  return Math.max(0, Math.min(CONFIG.MAX_DISPATCHES_PER_RUN, headroom));
}

/** Minutes between two instants; Infinity when `then` is unusable. */
function minutesSince(then, now) {
  const thenMs = new Date(then ?? '').getTime();
  const nowMs = new Date(now ?? Date.now()).getTime();
  if (Number.isNaN(thenMs) || Number.isNaN(nowMs)) return Number.POSITIVE_INFINITY;
  return (nowMs - thenMs) / 60_000;
}

/**
 * Why this PR's head branch is unreachable, or `null` when it is a branch in
 * this repository.
 *
 * The fix job checks out the bare `head.ref` in THIS repository, so a fork PR
 * either fails on a missing branch or — worse, if a same-named branch exists
 * here — edits and pushes the wrong one. It has to be refused before the
 * dispatch label and SHA marker are written, because those block any retry.
 *
 * `head.repo` is null when the fork has been deleted. A fixture that never
 * mentions a head repo is "not stated", which is not evidence of a fork.
 * @param {object} pr nested (`head.repo.full_name`) or flattened (`headRepo`)
 * @param {string} [repo] the base repository, `owner/name`
 * @returns {string|null}
 */
function describeForeignHead(pr, repo) {
  const stated = (pr.head != null && 'repo' in pr.head) || 'headRepo' in pr;
  if (!stated) return null;
  const headRepo = pr.head?.repo?.full_name ?? pr.headRepo ?? null;
  const baseRepo = repo ?? pr.base?.repo?.full_name ?? null;
  if (headRepo !== null && (!baseRepo || headRepo === baseRepo)) return null;
  return `Head branch lives in ${headRepo ?? 'a deleted fork'}, not ${baseRepo ?? 'this repository'} — the fixer can only push to branches in this repository.`;
}

/**
 * The Step-4 gate: everything that drops a PR silently (no label, no comment)
 * before the rubric is consulted. Returns `null` when the PR reaches the rubric.
 * Exported so the scanner can avoid fetching job logs for PRs that are already
 * out.
 * @param {object} input see {@link decidePrAction}; `targeted: true` waives the
 *   two "yield to someone else" waits (settling window, recent human activity)
 *   for an operator-named PR, and nothing else
 * @returns {{action: 'skip', reason: string, announce: false}|null}
 */
export function screenPr(input = {}) {
  const {
    pr = {},
    checks = {},
    markers = {},
    latestHumanActivityAt = null,
    now = new Date(),
    targeted = false,
  } = input;
  const drop = (reason) => ({ action: 'skip', reason, announce: false });

  if (!isAutomationPr(pr)) {
    return drop(
      'Not a routine automation PR (author is human and head branch has no automation prefix).'
    );
  }

  const foreignHead = describeForeignHead(pr, input.repo);
  if (foreignHead) return drop(foreignHead);
  const failing = Array.isArray(checks.failing) ? checks.failing : [];
  if (failing.length === 0) {
    return drop(checks.pending ? 'Checks are still running.' : 'CI is green.');
  }

  const labels = (Array.isArray(pr.labels) ? pr.labels : []).map((l) =>
    String(typeof l === 'string' ? l : (l?.name ?? ''))
  );
  const selfHealing = labels.find((l) => SELF_HEALING_LABELS.includes(l));
  if (selfHealing) {
    return drop(
      `Labelled "${selfHealing}" — this repo self-heals it through the renovate reconcile workflows; acting would race them.`
    );
  }

  // Both waits below exist to yield to somebody else who is probably already on
  // it — the repo's own reconcilers, or a human. A `targeted` run is an operator
  // naming this one PR by number, so there is nobody to yield to and waiting
  // would only make the run untestable. Every other guard still applies.
  if (!targeted) {
    const failureAge = minutesSince(checks.newestFailureAt, now);
    if (failureAge < CONFIG.SETTLING_MINUTES) {
      return drop(
        `Newest failing conclusion is ${failureAge.toFixed(0)}m old (< ${CONFIG.SETTLING_MINUTES}m settling window).`
      );
    }

    if (latestHumanActivityAt) {
      const humanAge = minutesSince(latestHumanActivityAt, now);
      if (humanAge < CONFIG.HUMAN_ACTIVITY_MINUTES) {
        return drop(
          `A human commented, reviewed, or pushed ${humanAge.toFixed(0)}m ago (< ${CONFIG.HUMAN_ACTIVITY_MINUTES}m) — leaving it to them.`
        );
      }
    }
  }

  const headSha = String(pr.headSha ?? pr.head?.sha ?? '').toLowerCase();
  const dispatchedShas = markers.dispatchedShas ?? new Set();
  const skippedShas = markers.skippedShas ?? new Set();
  const attempts = Number(markers.attempts ?? dispatchedShas.size ?? 0);

  if (dispatchedShas.has?.(headSha)) {
    return drop(`A fixer was already dispatched for head SHA ${headSha.slice(0, 7)}.`);
  }
  if (attempts >= CONFIG.MAX_ATTEMPTS_PER_PR) {
    return drop(
      `Already dispatched ${attempts} time(s) (cap ${CONFIG.MAX_ATTEMPTS_PER_PR}) — leaving this PR for a human.`
    );
  }
  if (skippedShas.has?.(headSha)) {
    return drop(
      `Head SHA ${headSha.slice(0, 7)} was already skipped; a new head SHA makes it eligible again.`
    );
  }
  return null;
}

/**
 * Decide what to do with one failing automation PR. Every branch carries a
 * human-readable `reason`. `announce` is false for the silent Step-4 drops and
 * for the re-run path (a re-run is already visible in the checks UI); it is
 * true only for the skip path that owes the PR one short comment.
 * @param {{
 *   pr: {number?: number, title?: string, headSha?: string, headRef?: string, labels?: Array<string|{name?: string}>, user?: object, head?: object},
 *   checks: {failing?: Array<object>, pending?: boolean, newestFailureAt?: string|null},
 *   markers?: {skippedShas?: Set<string>, dispatchedShas?: Set<string>, attempts?: number},
 *   latestHumanActivityAt?: string|null,
 *   alreadyRerunSha?: boolean,
 *   now?: Date|string,
 * }} input
 * @returns {{action: 'rerun'|'dispatch'|'skip', reason: string, announce: boolean, category?: string|null}}
 */
export function decidePrAction(input = {}) {
  const screened = screenPr(input);
  if (screened) return screened;

  const { checks = {}, alreadyRerunSha = false } = input;
  const verdict = classifyFailures(checks.failing);

  if (verdict.kind === 'blocked') {
    return { action: 'skip', reason: verdict.reason, announce: true, category: verdict.category };
  }
  if (verdict.kind === 'infra') {
    if (alreadyRerunSha) {
      return {
        action: 'skip',
        reason: `${verdict.reason} This head SHA was already re-run and failed again, so it is not a flake.`,
        announce: true,
        category: verdict.category,
      };
    }
    return {
      action: 'rerun',
      reason: `${verdict.reason} Re-running the failed jobs.`,
      announce: false,
      category: verdict.category,
    };
  }
  if (verdict.kind === 'code') {
    return {
      action: 'dispatch',
      reason: `${verdict.reason} Dispatching a fixer to get CI green on the branch.`,
      announce: true,
      category: verdict.category,
    };
  }
  return { action: 'skip', reason: verdict.reason, announce: true, category: null };
}

/**
 * Flatten failure details into ONE line safe to interpolate into a workflow
 * matrix value and a YAML block scalar. Newlines would break the prompt's
 * indentation and `${{` would be re-expanded by Actions, so both are removed.
 * @param {Array<{name?: string, conclusion?: string, logExcerpt?: string}>} failures
 * @param {number} maxChars
 * @returns {string}
 */
export function formatFailuresForMatrix(failures = [], maxChars = 1500) {
  const parts = (Array.isArray(failures) ? failures : []).map((f) => {
    const excerpt = String(f.logExcerpt ?? f.description ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    const head = `${f.name ?? 'unknown check'}: ${f.conclusion ?? 'failure'}`;
    return excerpt ? `${head} — ${excerpt}` : head;
  });
  return parts
    .join(' | ')
    .replaceAll('${{', '$ {{')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, maxChars);
}

/** A line that, on its own, looks like it names a failure. */
const FAILURE_LINE = /error|fail|✕|✗|cannot|unable|denied|conflict|timed out|canceled|cancelled/i;

/**
 * Lines kept after each {@link FAILURE_LINE}. A gate that fails usually announces
 * the failure on one line and then spends the next few naming the offending file
 * and prescribing the fix — none of which contain a failure-ish word, so a
 * line-by-line filter throws away the only actionable part. Trailing context
 * only: the detail follows the announcement in every gate this repo runs, and
 * leading context would pad the excerpt with the passing output that preceded it.
 */
const CONTEXT_AFTER = 8;

/**
 * Collapse a raw job log to the tail lines most likely to name the failure,
 * each with the following lines that explain it.
 * @param {string} log raw text from `GET /actions/jobs/{id}/logs`
 * @param {number} maxChars
 * @returns {string}
 */
export function extractLogExcerpt(log, maxChars = 2000) {
  const lines = String(log ?? '')
    .split(/\r?\n/)
    // Strip the ISO timestamp Actions prefixes every log line with.
    .map((line) => line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, ''))
    .filter((line) => line.trim().length > 0);
  const keep = new Set();
  for (const [index, line] of lines.entries()) {
    if (!FAILURE_LINE.test(line)) continue;
    const last = Math.min(lines.length - 1, index + CONTEXT_AFTER);
    for (let i = index; i <= last; i += 1) keep.add(i);
  }
  const interesting = [...keep].sort((a, b) => a - b).map((i) => lines[i]);
  const chosen = (interesting.length ? interesting : lines).slice(-40);
  return chosen.join('\n').slice(-maxChars);
}
