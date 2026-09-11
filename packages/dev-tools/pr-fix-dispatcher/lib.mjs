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
 * Head-branch prefixes whose PRs exist only to move a dependency version. A
 * subset of {@link AUTOMATION_BRANCH_PREFIXES}: an `automation/` or `rum-fix/`
 * branch carries hand-shaped code and gets no dependency waiver.
 */
export const DEPENDENCY_UPDATE_BRANCH_PREFIXES = ['renovate/'];

/**
 * Labels whose PRs this repo already self-heals through
 * `renovate-patch-reconcile.yml` / `renovate-format-reconcile.yml` /
 * `renovate-swift-pin-reconcile.yml`. Acting on them would race those workflows.
 */
export const SELF_HEALING_LABELS = ['patched-dependency', 'formatter-bump', 'swift-pin'];

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
 * npm refusing to resolve a tree. For most authors this is a hard skip — an
 * `ERESOLVE` on a hand-written feature branch means somebody has to decide which
 * version wins. On a dependency-update PR it is the opposite: resolving the tree
 * for a version Renovate already chose is the entire content of the PR, and the
 * fix is regenerating the lockfile or widening a sibling range. Blocking it
 * there made the dispatcher structurally blind on its single most common
 * candidate (PR #2964, `fix(deps): update codemirror`).
 *
 * Shared verbatim by {@link HARD_SKIP_SIGNATURES} and {@link CODE_SIGNATURES};
 * {@link isDependencyUpdatePr} picks which table sees it. The two must stay one
 * pattern — a text that stops matching the hard-skip entry but still matches the
 * code entry would dispatch fixers on non-automation PRs.
 */
const DEPENDENCY_RESOLUTION_PATTERN =
  /ERESOLVE|unable to resolve dependency tree|no matching version found|peer dep|requires a peer of/i;

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
  // Stays hard for every author including Renovate: satisfying it means editing
  // the Node version in `.github/workflows/`, which the fixer is told not to do.
  {
    category: 'engine-mismatch',
    pattern: /engine node is incompatible|EBADENGINE|unsupported engine/i,
  },
  // Waived for dependency-update PRs — see {@link DEPENDENCY_RESOLUTION_PATTERN}.
  { category: 'dependency-resolution', pattern: DEPENDENCY_RESOLUTION_PATTERN },
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
  // `go.mod` / `go.sum` are the Go half of the same "a generated manifest fell
  // out of step with its source" failure `package-lock.json` covers, and the Go
  // toolchain shares none of npm's vocabulary. `make tidy-check` in
  // packages/slicc-cli and packages/go-optel prints `go.mod/go.sum are not tidy
  // — run 'go mod tidy'`; PR #3045 (a Renovate pion/webrtc bump) skipped as
  // `unknown` on exactly that line and a human pushed the `go mod tidy` commit.
  {
    category: 'generated-artifact',
    pattern:
      /package-lock\.json|lock ?file (is )?out of (sync|date)|npm ci can only install|git diff --exit-code|generated file .* out of date|working tree is dirty|go mod tidy|go\.(mod|sum) (are|is) not tidy|missing go\.sum entry/i,
  },
  // Reachable only for a dependency-update PR: for every other author
  // {@link HARD_SKIP_SIGNATURES} matches the same text first and blocks. See
  // {@link DEPENDENCY_RESOLUTION_PATTERN}.
  { category: 'dependency-resolution', pattern: DEPENDENCY_RESOLUTION_PATTERN },
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

/**
 * Is this PR a pure dependency bump? Keyed on the head branch alone, NOT on the
 * author: `app/renovate` opens these, but so does a human re-pushing a renovate
 * branch, and both PRs have the same mechanical content. Author type is the
 * wrong key in the other direction too — every bot in this repo is a `Bot`, and
 * a backlog-dispatcher PR must not inherit the dependency waiver.
 * @param {{head?: {ref?: string}, headRef?: string}} pr
 * @returns {boolean}
 */
export function isDependencyUpdatePr(pr) {
  if (!pr) return false;
  const ref = String(pr.head?.ref ?? pr.headRef ?? '');
  return DEPENDENCY_UPDATE_BRANCH_PREFIXES.some((prefix) => ref.startsWith(prefix));
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
 * Bare check-run name. GitHub reports this repo's jobs as `lint` / `ci`; some
 * UIs and required-check titles use the `CI / lint` form.
 *
 * The trailing matrix suffix goes too. GitHub appends the matrix leg to the
 * check-run name — `node-matrix-tests (26)`, `slicc-cli (ubuntu-latest)` — and
 * every name-keyed lookup below is an exact match, so without this strip
 * {@link WELL_KNOWN_CODE_JOBS}'s `node-matrix-tests` entry could never fire: that
 * job is *only* ever reported with a leg. Same for a `lint (…)` leg reaching
 * {@link JOB_NAME_CODE_CATEGORIES}.
 * @param {string} jobName
 * @returns {string}
 */
function bareCheckName(jobName) {
  return String(jobName ?? '')
    .trim()
    .replace(/^ci\s*\/\s*/i, '')
    .replace(/\s*\([^()]*\)\s*$/, '')
    .trim()
    .toLowerCase();
}

/**
 * The `CI / ci` aggregator job (`if: always()` over `needs: [*]`). Its log
 * never names a cause — it only echoes that a sibling failed.
 * @param {string} jobName
 * @returns {boolean}
 */
export function isCiAggregatorJob(jobName) {
  return bareCheckName(jobName) === 'ci';
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
  if (!isCiAggregatorJob(jobName)) return false;
  return /one or more jobs failed or were cancelled/i.test(String(logExcerpt));
}

/**
 * Jobs whose name alone is a code-failure signature: the log may be empty or
 * truncated (MAX_LOGS_PER_PR, a 403/410 log fetch) and still not say "biome"
 * / "lint error". Checked after log-based CODE_SIGNATURES (so a debt-gate
 * excerpt still wins) and after INFRA_SIGNATURES (so a network flake on the
 * lint job is still a re-run).
 */
const JOB_NAME_CODE_CATEGORIES = {
  lint: 'lint',
  typecheck: 'types',
};

/**
 * Jobs in `ci.yml` that do NOT evaluate this repo's code, so their name alone is
 * no evidence of a fixable failure.
 *
 * This is an allow-by-default deny-list, and it replaced an explicit
 * `WELL_KNOWN_CODE_JOBS` allow-list that named 7 of the workflow's 30 jobs.
 * Every job the allow-list omitted — `go-optel`, `cloudflare-worker`,
 * `node-server`, `cherry`, `spoon`, `webcomponents`, `cloud-core`,
 * `global-install`, `slicc-cli` — fell through to `unknown` and skipped, which
 * is the whole failure mode this fallback exists to prevent. Naming the handful
 * of non-code jobs is both shorter and self-maintaining: a job added to `ci.yml`
 * tomorrow is a code job by default rather than a silent skip.
 *
 * `release-gate` is absent on purpose — {@link HARD_SKIP_JOB_PATTERN} already
 * blocks it by name, earlier and more strongly.
 */
/**
 * The workflow whose jobs evaluate this repo's code. Promotion by job NAME alone
 * is scoped to it.
 *
 * `GET /commits/{sha}/check-runs` returns every check on the SHA, not just
 * `ci.yml`'s — a Renovate PR also carries `AI Comment Detection`,
 * `Renovate Lockfile Reconcile`, `Claude PR Review`, `Storybook Screenshots`.
 * Under the allow-by-default rule below, a failure in any of those would
 * otherwise promote on its name and send a fixer to edit branch code because a
 * *labelling* job broke — and `Renovate Lockfile Reconcile` is one of the very
 * reconcilers the dispatcher deliberately refuses to race.
 *
 * This scopes the NAME-ONLY path only. A failure whose log genuinely says
 * `biome found 2 errors` still classifies as `code` through
 * {@link CODE_SIGNATURES} whatever workflow it came from, because there the
 * evidence is the log rather than the name.
 */
export const CODE_WORKFLOW_NAME = 'CI';

const NON_CODE_JOBS = new Set([
  // The `if: always()` rollup over `needs: [*]`; its log only echoes that a
  // sibling failed.
  'ci',
  // The `dorny/paths-filter` job every other job gates on.
  'changes',
]);

/**
 * Category for a failing job that evaluates this repo's code, or null when the
 * job's name alone is no evidence. `lint` / `typecheck` map onto the existing
 * CODE_SIGNATURES categories; `swift-*` covers swift-server / swift-optel /
 * swift-launcher / …; every other name stays as itself so the dispatch reason
 * names the job.
 * @param {string} jobName
 * @returns {string|null}
 */
export function wellKnownCodeCategory(jobName) {
  const bare = bareCheckName(jobName);
  if (!bare || NON_CODE_JOBS.has(bare)) return null;
  if (JOB_NAME_CODE_CATEGORIES[bare]) return JOB_NAME_CODE_CATEGORIES[bare];
  if (bare.startsWith('swift-')) return 'build';
  return bare;
}

/** @param {string} name @param {string} category */
function codeVerdict(name, category) {
  return {
    kind: 'code',
    category,
    reason: `"${name}" failed in the code (${category}).`,
  };
}

/**
 * Spend the per-PR log budget on jobs that can name a cause. The `ci`
 * aggregator is last: its log is boilerplate (`One or more jobs failed…` plus
 * the env dump) and fetching it first used to starve a sibling (PR #3008).
 * @param {Array<{name?: string, jobName?: string}>} failing
 * @returns {Array<{name?: string, jobName?: string}>}
 */
export function prioritizeLogFetch(failing = []) {
  const list = Array.isArray(failing) ? [...failing] : [];
  return list.sort((a, b) => {
    const aAgg = isCiAggregatorJob(a.name ?? a.jobName);
    const bAgg = isCiAggregatorJob(b.name ?? b.jobName);
    return Number(aAgg) - Number(bAgg);
  });
}

/**
 * Classify a single failure as infrastructure, code, blocked (hard skip), or
 * unknown, from its job name plus a log excerpt.
 * @param {{jobName?: string, logExcerpt?: string}} failure
 * @param {{dependencyUpdate?: boolean}} [options] `dependencyUpdate: true` waives
 *   the `dependency-resolution` hard skip, and nothing else — see
 *   {@link DEPENDENCY_RESOLUTION_PATTERN}
 * @returns {{kind: 'blocked'|'code'|'infra'|'unknown', category: string|null, reason: string}}
 */
export function classifyFailure(
  { jobName = '', logExcerpt = '' } = {},
  { dependencyUpdate = false } = {}
) {
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
  // Filter the table rather than post-hoc unblocking the verdict: `blocked` is
  // first-match-wins, so dropping the waived entry lets a later hard skip
  // (`ci-config-change`) still win on a log that names both.
  const hardSkips = dependencyUpdate
    ? HARD_SKIP_SIGNATURES.filter((entry) => entry.category !== 'dependency-resolution')
    : HARD_SKIP_SIGNATURES;
  const blocked = matchSignature(hardSkips, text);
  if (blocked) {
    return {
      kind: 'blocked',
      category: blocked,
      reason: `"${name}" failed on ${blocked} — a hard-override category no automated path can fix.`,
    };
  }
  const code = matchSignature(CODE_SIGNATURES, text);
  if (code) return codeVerdict(name, code);
  const infra = matchSignature(INFRA_SIGNATURES, text);
  if (infra) {
    return {
      kind: 'infra',
      category: infra,
      reason: `"${name}" failed in CI plumbing (${infra}) without evaluating the code.`,
    };
  }
  // Job name `lint` / `typecheck` does not match CODE_SIGNATURES.lint (that
  // pattern wants "biome" / "lint error"), so an empty excerpt used to land
  // here as unknown. After infra, so a network flake on the lint job is still
  // a re-run.
  const named = JOB_NAME_CODE_CATEGORIES[bareCheckName(name)];
  if (named) return codeVerdict(name, named);
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
 *
 * The unknown fallback must not pick the `ci` aggregator. GitHub lists that
 * check first (PR #3008), `isCiAggregatorNoise` correctly forces it to
 * `unknown`, and returning `classified[0]` then skipped with the aggregator's
 * sentence even when a sibling (`lint`) had also failed. Prefer a
 * non-aggregator unknown; if any remaining job is a well-known code job,
 * promote it to `code` so the PR dispatches.
 * @param {Array<{name?: string, jobName?: string, logExcerpt?: string}>} failures
 * @param {{dependencyUpdate?: boolean}} [options] forwarded to {@link classifyFailure}
 * @returns {{kind: 'blocked'|'code'|'infra'|'unknown', category: string|null, reason: string}}
 */
export function classifyFailures(failures = [], options = {}) {
  const list = Array.isArray(failures) ? failures : [];
  const classified = list.map((f) => {
    const jobName = f.jobName ?? f.name;
    return {
      jobName,
      promotable: isNamePromotable(f),
      ...classifyFailure(
        {
          jobName,
          logExcerpt: f.logExcerpt ?? f.description ?? '',
        },
        options
      ),
    };
  });
  for (const kind of ['blocked', 'code', 'infra']) {
    const hit = classified.find((c) => c.kind === kind);
    if (hit) return hit;
  }
  return pickUnknownFallback(classified);
}

/** Workflow-run id embedded in a check-run's `details_url` (…/actions/runs/<run>/job/<job>). */
function runIdFromDetailsUrl(url) {
  const match = /\/actions\/runs\/(\d+)/.exec(String(url ?? ''));
  return match ? match[1] : null;
}

/**
 * Stamp each failing check with the name of the workflow run that produced it,
 * resolved against `GET /actions/runs?head_sha=…` — which the scanner already
 * fetches for `hasRerunForSha`, so this costs no extra request.
 *
 * `workflow` is `null` — deliberately, not absent — when the check could not be
 * traced to an Actions run: a check-run posted by a GitHub App (Codex, Copilot)
 * has no `/actions/runs/` URL at all. {@link isNamePromotable} reads that `null`
 * as "looked, found nothing", which is a refusal; absent means "never stated"
 * and stays permissive for hand-built input. Same null-vs-absent distinction as
 * {@link describeForeignHead}.
 * @param {Array<{detailsUrl?: string|null}>} failing mutated in place
 * @param {Array<{id?: number|string, name?: string}>} runs
 * @returns {Array<object>} the same array
 */
export function attachWorkflowNames(failing = [], runs = []) {
  const byRunId = new Map();
  for (const run of Array.isArray(runs) ? runs : []) {
    if (run?.id != null) byRunId.set(String(run.id), run.name ?? null);
  }
  for (const failure of Array.isArray(failing) ? failing : []) {
    if (!failure) continue;
    const runId = runIdFromDetailsUrl(failure.detailsUrl);
    failure.workflow = (runId && byRunId.get(runId)) || null;
  }
  return Array.isArray(failing) ? failing : [];
}

/**
 * May this failure be promoted to `code` on its job NAME alone? Requires an
 * Actions check-run from {@link CODE_WORKFLOW_NAME}.
 *
 * A commit status (`kind: 'status'`) never qualifies: its context belongs to an
 * external app, not to a job in this repo, and its `description` already reaches
 * {@link CODE_SIGNATURES} as the excerpt.
 * @param {{kind?: string, workflow?: string|null}} failure
 * @returns {boolean}
 */
function isNamePromotable(failure) {
  if (!failure || failure.kind === 'status') return false;
  // Never stated — a hand-built failure, where the job name is all the evidence
  // there is. Stated-but-null is {@link attachWorkflowNames} reporting that it
  // could not trace the check to an Actions run, and that is a refusal.
  if (!('workflow' in failure)) return true;
  if (failure.workflow == null) return false;
  return String(failure.workflow).trim().toLowerCase() === CODE_WORKFLOW_NAME.toLowerCase();
}

/**
 * Last-resort unknown fold: never let aggregator noise own the skip reason.
 * @param {Array<{jobName?: string, promotable?: boolean, kind: string, category: string|null, reason: string}>} classified
 */
function pickUnknownFallback(classified) {
  const named = classified.find((c) => c.promotable && wellKnownCodeCategory(c.jobName));
  if (named) return codeVerdict(named.jobName, wellKnownCodeCategory(named.jobName));
  const nonAggregator = classified.find((c) => !isCiAggregatorJob(c.jobName));
  return (
    nonAggregator ??
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
  const verdict = classifyFailures(checks.failing, {
    dependencyUpdate: isDependencyUpdatePr(input.pr),
  });

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
 * line-by-line filter throws away the only actionable part.
 */
const CONTEXT_AFTER = 8;

/**
 * Lines kept BEFORE each {@link FAILURE_LINE}. Trailing context alone assumes the
 * announcement always precedes the prescription, and a `make`-driven job breaks
 * that: `make tidy-check` prints its own summary line and only then does `make`
 * echo `*** [Makefile:48: tidy-check] Error 1`, with `##[error]Process
 * completed` last. On PR #3045 that ordering put the one actionable line —
 * `go.mod/go.sum are not tidy — run 'go mod tidy'` — two lines ABOVE the nearest
 * failure-ish line, so it never reached the excerpt and the PR classified as
 * `unknown`. Kept deliberately short: leading context pads the excerpt with the
 * passing output that preceded the failure.
 */
const CONTEXT_BEFORE = 3;

/**
 * Collapse a raw job log to the tail lines most likely to name the failure, each
 * with the lines around it that explain it.
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
    const first = Math.max(0, index - CONTEXT_BEFORE);
    const last = Math.min(lines.length - 1, index + CONTEXT_AFTER);
    for (let i = first; i <= last; i += 1) keep.add(i);
  }
  const interesting = [...keep].sort((a, b) => a - b).map((i) => lines[i]);
  const chosen = (interesting.length ? interesting : lines).slice(-40);
  return chosen.join('\n').slice(-maxChars);
}
