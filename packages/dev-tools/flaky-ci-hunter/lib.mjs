/*
 * Flaky CI Hunter — pure logic.
 *
 * Weekly hunt for jobs and tests that fail NONDETERMINISTICALLY on unchanged
 * code, so a single fixer can be dispatched at the worst offender. The core
 * definition everything here is built around: a flake is not "a job that failed
 * often", it is **the same commit producing two different outcomes**. If we
 * cannot point at two runs of identical code that disagreed, we have not found
 * a flake and we dispatch nothing.
 *
 * This module is intentionally free of I/O so it can be unit-tested in
 * isolation — the GitHub REST calls and `$GITHUB_OUTPUT` writes live in
 * `scan-flakes.mjs`. Mirrors `packages/dev-tools/pr-review-gate/lib.mjs`.
 *
 * Evidence sources (strongest first):
 *   1. Attempt flips (definitive) — one run, `run_attempt > 1`, a job that
 *      concluded `failure` on an earlier attempt and `success` on a later one.
 *      Identical code by construction.
 *   3. Green-then-red on `main` — a job that passed on a PR head and failed
 *      post-merge. Weak (a `main` merge carries other people's work), so it
 *      only counts when the same job also shows up in source 1.
 *
 * There is no source 2. The original (vendor-hosted) version of this expert
 * read a sibling "PR Fix Dispatcher" expert's state directory to learn which
 * runs it had re-run on suspicion of flakiness. Under GitHub-native state that
 * source collapses into source 1: a dispatcher re-run is precisely what
 * *creates* attempt 2, so `run_attempt > 1` already contains that evidence,
 * definitively and without reading another workflow's private state.
 */

/** Tunables. The scanner may override the window/log/threshold trio from env. */
export const CONFIG = Object.freeze({
  /** Trailing evidence window, in days. */
  WINDOW_DAYS: 7,
  /** Cap on runs whose job logs we fetch. Listing runs is cheap; logs are not. */
  MAX_LOG_READS: 6,
  /** A job must have flipped on at least this many DISTINCT commits. One flip is noise. */
  FLAKE_THRESHOLD: 2,
  /** Deliberately tiny — flaky-test fixes are subtle and a wrong one is worse than none. */
  MAX_DISPATCHES_PER_RUN: 1,
  /** After dispatching for a job, wait this long (or for the fix PR to merge). */
  COOLDOWN_DAYS: 21,
  /** After this many dispatches for one job, stop and leave it for a human. */
  MAX_ATTEMPTS_PER_JOB: 2,
  /** Cap on runs whose per-attempt job lists we fetch (source 1). */
  MAX_ATTEMPT_RUN_READS: 40,
  /** Cap on `main` failures we expand into job lists (source 3). */
  MAX_MAIN_RUN_READS: 20,
});

/** Branch prefix that doubles as the durable per-job dispatch registry. */
export const FIX_BRANCH_PREFIX = 'automation/flaky-fix/';

/** Label the fixer puts on its PR, so the registry query stays cheap to eyeball. */
export const FIX_LABEL = 'flaky-fix';

const MS_PER_DAY = 86_400_000;

/** NUL cannot appear in a workflow or job name, so it is a safe composite-key separator. */
const KEY_SEP = '\u0000';

/** Conclusions that count as "this job did not pass". */
const FAILING_CONCLUSIONS = new Set(['failure', 'timed_out']);

/** Events that identify a pull-request-side run. */
const PR_EVENTS = new Set(['pull_request', 'pull_request_target']);

/** Events that identify a post-merge run on the default branch. */
const MAIN_EVENTS = new Set(['push', 'merge_group']);

/** Source strength, used when the same `(workflow, job, sha)` flip is seen twice. */
const SOURCE_RANK = { attempt: 2, 'main-regression': 1 };

/**
 * Composite `(workflow, job)` key.
 * @param {string} workflow
 * @param {string} job
 * @returns {string}
 */
export function jobKey(workflow, job) {
  return `${workflow}${KEY_SEP}${job}`;
}

/**
 * The UTC calendar day of a date as `YYYY-MM-DD`.
 * @param {Date|string|number} value
 * @returns {string}
 */
export function utcDay(value) {
  const d = value instanceof Date ? value : new Date(value);
  return d.toISOString().slice(0, 10);
}

/**
 * The list of UTC day strings the scanner must query ONE AT A TIME, oldest
 * first, ending on `now`'s UTC day.
 *
 * This is the single most important correctness detail in the whole expert.
 * `GET /repos/{owner}/{repo}/actions/runs` returns **at most 1000 items no
 * matter how you page**, while `total_count` reports the true size. This repo
 * produces roughly 2400 runs a week, so one window-wide query silently
 * truncates to the most recent ~2.5 days and hides the rest of the evidence —
 * a truncated scan looks exactly like a quiet week. Querying one day at a time
 * keeps every request a few hundred runs, well under the cap.
 *
 * Slicing per workflow instead is NOT equivalent: a single high-volume workflow
 * can exceed 1000 runs in a week on its own, which reintroduces the same blind
 * spot.
 *
 * @param {Date|string|number} now end of the window (inclusive)
 * @param {number} [windowDays] number of days, including `now`'s day
 * @returns {string[]} exactly `windowDays` `YYYY-MM-DD` strings, ascending
 */
export function dayWindows(now, windowDays = CONFIG.WINDOW_DAYS) {
  const count = Math.max(1, Math.floor(Number(windowDays) || CONFIG.WINDOW_DAYS));
  const end = now instanceof Date ? now : new Date(now);
  const endMidnight = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  const days = [];
  for (let i = count - 1; i >= 0; i -= 1) days.push(utcDay(new Date(endMidnight - i * MS_PER_DAY)));
  return days;
}

/**
 * The `created=` query parameter pinning a runs listing to ONE UTC day. The
 * closed range `day..day` is what keeps each request under the 1000-item cap
 * (see `dayWindows`).
 * @param {string} day `YYYY-MM-DD`
 * @returns {string} e.g. `created=2025-03-31..2025-03-31`
 */
export function createdRangeParam(day) {
  return `created=${day}..${day}`;
}

/**
 * Source 1 — attempt flips (definitive). Given every attempt's job list for a
 * SINGLE run (hence a single `head_sha`), report each job that concluded
 * `failure`/`timed_out` on an earlier attempt and `success` on a later one.
 * Same code, two outcomes: no corroboration needed.
 *
 * `failure` → `failure` is a broken job, not a flake. `success` → `success` is
 * nothing. `success` → `failure` on a later attempt is deliberately NOT counted
 * here: re-runs are requested for red runs, so that ordering means the earlier
 * green belonged to a different job graph, not to a flip we can prove.
 *
 * @param {Record<number|string, Array<{name?: string, conclusion?: string|null, id?: number, html_url?: string}>>} jobsByAttempt
 *   attempt number → the jobs of that attempt
 * @param {{workflow?: string, headSha?: string, runUrl?: string, runId?: number}} [meta]
 * @returns {Array<{workflow: string, job: string, headSha: string, source: 'attempt', runUrl: string, runId?: number, jobId?: number, detail: string}>}
 */
export function findAttemptFlips(jobsByAttempt, meta = {}) {
  const { workflow = 'unknown', headSha = '', runUrl = '', runId } = meta;
  const attempts = Object.keys(jobsByAttempt ?? {})
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);

  /** job name → the first attempt on which it failed */
  const firstFailure = new Map();
  const flips = [];

  for (const attempt of attempts) {
    for (const job of jobsByAttempt[attempt] ?? []) {
      const name = job?.name;
      if (!name) continue;
      const conclusion = job?.conclusion;
      if (FAILING_CONCLUSIONS.has(conclusion)) {
        if (!firstFailure.has(name)) firstFailure.set(name, { attempt, conclusion, jobId: job.id });
        continue;
      }
      if (conclusion !== 'success') continue;
      const prior = firstFailure.get(name);
      if (!prior || prior.attempt >= attempt) continue;
      flips.push({
        workflow,
        job: name,
        headSha,
        source: 'attempt',
        runUrl,
        runId,
        // The FAILING attempt's job id — that is the log Step 3 needs to read.
        jobId: prior.jobId,
        successJobId: job.id,
        detail: `attempt ${prior.attempt} ${prior.conclusion} → attempt ${attempt} success on ${headSha.slice(0, 8)}`,
      });
      // One flip per (job, sha); a third attempt re-failing is not new evidence.
      firstFailure.delete(name);
    }
  }
  return flips;
}

/**
 * Source 3 — green-then-red on `main`. A job that passed on a PR's head and
 * then failed post-merge (`push`/`merge_group`) for the same `head_sha`.
 *
 * Weak by construction: a `main` run carries whatever else landed, so a red
 * post-merge job may be a genuine regression rather than nondeterminism. It
 * therefore only counts toward the threshold when the SAME job also appears in
 * source 1 — that is the corroboration requirement, enforced here rather than
 * left to the caller's discretion.
 *
 * @param {{observations?: Array<{workflow: string, job: string, headSha: string, conclusion?: string|null, event?: string, branch?: string, runUrl?: string}>, corroboratedJobs?: Set<string>, defaultBranch?: string}} input
 * @returns {Array<{workflow: string, job: string, headSha: string, source: 'main-regression', runUrl: string, detail: string}>}
 */
export function findMainRegressionFlips({
  observations = [],
  corroboratedJobs = new Set(),
  defaultBranch = 'main',
} = {}) {
  /** `(sha, workflow, job)` → { prPass, mainFail } */
  const groups = new Map();
  for (const o of observations) {
    if (!o?.workflow || !o?.job || !o?.headSha) continue;
    const key = `${o.headSha}${KEY_SEP}${jobKey(o.workflow, o.job)}`;
    const group = groups.get(key) ?? { obs: o, prPass: null, mainFail: null };
    if (PR_EVENTS.has(o.event) && o.conclusion === 'success') group.prPass ??= o;
    const onMain = MAIN_EVENTS.has(o.event) && (o.branch ?? defaultBranch) === defaultBranch;
    if (onMain && FAILING_CONCLUSIONS.has(o.conclusion)) group.mainFail ??= o;
    groups.set(key, group);
  }

  const flips = [];
  for (const { obs, prPass, mainFail } of groups.values()) {
    if (!prPass || !mainFail) continue;
    if (!corroboratedJobs.has(jobKey(obs.workflow, obs.job))) continue;
    flips.push({
      workflow: obs.workflow,
      job: obs.job,
      headSha: obs.headSha,
      source: 'main-regression',
      runUrl: mainFail.runUrl ?? '',
      detail: `success on the PR head (${prPass.runUrl ?? 'PR run'}) then ${mainFail.conclusion} post-merge on ${defaultBranch} for ${obs.headSha.slice(0, 8)}`,
    });
  }
  return flips;
}

/**
 * Deduplicate flips by `(workflow, job, head_sha)`, keeping the strongest
 * source. One flake observed through two lenses is ONE flip — counting it twice
 * would inflate the score and could push a single-flip job over the threshold.
 * @param {Array<{workflow: string, job: string, headSha: string, source: string}>} flips
 * @returns {Array<object>}
 */
export function dedupeFlips(flips = []) {
  const best = new Map();
  for (const flip of flips) {
    if (!flip?.workflow || !flip?.job || !flip?.headSha) continue;
    const key = `${jobKey(flip.workflow, flip.job)}${KEY_SEP}${flip.headSha}`;
    const current = best.get(key);
    const rank = SOURCE_RANK[flip.source] ?? 0;
    if (!current || rank > (SOURCE_RANK[current.source] ?? 0)) best.set(key, flip);
  }
  return [...best.values()];
}

/**
 * Group flips into candidates by `(workflow, job)`. `flakeScore` is the number
 * of DISTINCT commits the job flipped on — two flips on the same `head_sha`
 * score 1, not 2. Sorted worst offender first.
 * @param {Array<object>} flips
 * @returns {Array<{workflow: string, job: string, slug: string, flakeScore: number, sources: string[], flips: Array<object>}>}
 */
export function scoreCandidates(flips = []) {
  const groups = new Map();
  for (const flip of dedupeFlips(flips)) {
    const key = jobKey(flip.workflow, flip.job);
    const group = groups.get(key) ?? {
      workflow: flip.workflow,
      job: flip.job,
      slug: jobSlug(flip.workflow, flip.job),
      shas: new Set(),
      sources: new Set(),
      flips: [],
    };
    group.shas.add(flip.headSha);
    group.sources.add(flip.source);
    group.flips.push(flip);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((g) => ({
      workflow: g.workflow,
      job: g.job,
      slug: g.slug,
      flakeScore: g.shas.size,
      sources: [...g.sources].sort(),
      flips: g.flips,
    }))
    .sort(
      (a, b) =>
        b.flakeScore - a.flakeScore ||
        a.workflow.localeCompare(b.workflow) ||
        a.job.localeCompare(b.job)
    );
}

/**
 * Infrastructure causes this repo has ALREADY mitigated or that have no
 * in-repo fix at all. A candidate whose logs match one of these is a digest
 * entry, never a dispatch: there is nothing in the codebase to change, and the
 * re-run that turned it green is the whole remedy.
 * @type {ReadonlyArray<{id: string, label: string, note: string, all: RegExp[]}>}
 */
export const MITIGATED_INFRA_SIGNATURES = Object.freeze([
  {
    id: 'npm-registry-ipv6',
    label: 'npm registry reachability (IPv6)',
    note: 'Already mitigated in .github/workflows/ci.yml by `NODE_OPTIONS: --dns-result-order=ipv4first`, which removed ~79% of observed flakes.',
    all: [/registry\.npmjs\.org|npm ERR!/i, /ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND|network/i],
  },
  {
    id: 'artifact-transport',
    label: 'artifact/cache upload transport failure',
    note: 'GitHub-side artifact or cache transport failure; nothing in this repo to fix.',
    all: [
      /upload-artifact|artifactcache|results-receiver|actions\/cache/i,
      /ENOTFOUND|ECONNRESET|ECONNREFUSED|50[0-9] |Bad Gateway/i,
    ],
  },
  {
    id: 'runner-outage',
    label: 'runner outage / lost communication',
    note: 'The hosted runner died or lost the server connection; nothing in this repo to fix.',
    all: [
      /runner has received a shutdown signal|lost communication with the server|The self-hosted runner .* lost/i,
    ],
  },
]);

/**
 * The first mitigated-infrastructure signature matching a log excerpt, or
 * `null` when the failure looks like something the repo can actually fix.
 * @param {string} logText
 * @returns {{id: string, label: string, note: string}|null}
 */
export function matchMitigatedInfra(logText) {
  const text = String(logText ?? '');
  if (!text) return null;
  for (const sig of MITIGATED_INFRA_SIGNATURES) {
    if (sig.all.every((re) => re.test(text))) {
      return { id: sig.id, label: sig.label, note: sig.note };
    }
  }
  return null;
}

/** Whole workflows whose nondeterminism is a human conversation, not a fixer's PR. */
const EXCLUDED_WORKFLOWS = new Set([
  'release',
  'worker production deploy',
  'worker staging deploy',
]);

/** Job names that publish, release, or deploy. Matches CI's `release-gate` too. */
const EXCLUDED_JOB_PATTERN = /release|publish|deploy/i;

/**
 * True when the candidate is a release/publish/deploy job. A nondeterministic
 * release is a human conversation — never dispatch a fixer at one.
 * @param {{workflow?: string, job?: string}} candidate
 * @returns {boolean}
 */
export function isExcludedJob({ workflow = '', job = '' } = {}) {
  if (EXCLUDED_WORKFLOWS.has(String(workflow).trim().toLowerCase())) return true;
  return EXCLUDED_JOB_PATTERN.test(String(job));
}

/**
 * Branch-safe slug for a `(workflow, job)` pair. This slug — via
 * `automation/flaky-fix/<slug>` — IS the durable cross-run registry key: there
 * is no state file, so the fixer's branch name is what a later run reads back
 * to learn attempt counts and cooldown dates.
 * @param {string} workflow
 * @param {string} job
 * @returns {string}
 */
export function jobSlug(workflow, job) {
  const part = (s) =>
    String(s ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  const slug = [part(workflow), part(job)].filter(Boolean).join('--');
  return slug || 'unknown';
}

/**
 * The fixer's branch for a slug. Branding every fix branch this way is what
 * makes cooldown/attempt tracking possible without any persisted state.
 * @param {string} slug
 * @returns {string}
 */
export function fixBranch(slug) {
  return `${FIX_BRANCH_PREFIX}${slug}`;
}

/**
 * Inverse of `fixBranch`: the slug encoded in a branch name, or `null` when the
 * branch is not one of ours.
 * @param {string} branch
 * @returns {string|null}
 */
export function slugFromBranch(branch) {
  const ref = String(branch ?? '').replace(/^refs\/heads\//, '');
  if (!ref.startsWith(FIX_BRANCH_PREFIX)) return null;
  const slug = ref.slice(FIX_BRANCH_PREFIX.length).trim();
  return slug || null;
}

/**
 * Reduce the `automation/flaky-fix/*` pull requests into the per-job dispatch
 * history that replaces the old vendor state registry: how many times we
 * dispatched (`attempts`), when we last did (`lastDispatchAt` → cooldown), and
 * whether a fix already merged or is still open.
 * @param {Array<{number?: number, state?: string, created_at?: string, merged_at?: string|null, html_url?: string, head?: {ref?: string}}>} pulls
 * @returns {Record<string, {attempts: number, lastDispatchAt: string|null, lastMergedAt: string|null, openPrUrl: string|null}>}
 */
export function attemptsFromPulls(pulls = []) {
  /** @type {Record<string, {attempts: number, lastDispatchAt: string|null, lastMergedAt: string|null, openPrUrl: string|null}>} */
  const out = {};
  for (const pr of pulls) {
    const slug = slugFromBranch(pr?.head?.ref);
    if (!slug) continue;
    const entry = (out[slug] ??= {
      attempts: 0,
      lastDispatchAt: null,
      lastMergedAt: null,
      openPrUrl: null,
    });
    entry.attempts += 1;
    if (pr.created_at && (!entry.lastDispatchAt || pr.created_at > entry.lastDispatchAt)) {
      entry.lastDispatchAt = pr.created_at;
    }
    if (pr.merged_at && (!entry.lastMergedAt || pr.merged_at > entry.lastMergedAt)) {
      entry.lastMergedAt = pr.merged_at;
    }
    if (pr.state === 'open') entry.openPrUrl ??= pr.html_url ?? null;
  }
  return out;
}

/** Whole days between two instants (negative when `then` is in the future). */
function daysSince(then, now) {
  return (now.getTime() - new Date(then).getTime()) / MS_PER_DAY;
}

/**
 * Apply the Step-4 filters and the Step-5 decision to scored candidates. Every
 * branch returns a human-readable `reason`, because the digest is the only
 * place a human ever sees why a candidate was skipped.
 *
 * Candidates are expected pre-sorted worst-first (`scoreCandidates` does that).
 * `mitigatedInfra` / `localized` are attached by the scanner after it reads
 * logs; a candidate with neither field set is treated as un-localized and
 * therefore deferred, since Step 3 requires a named failure mode.
 *
 * @param {{candidates?: Array<object>, threshold?: number, cooldownDays?: number, maxAttempts?: number, maxDispatches?: number, attemptsByJob?: Record<string, object>, now?: Date}} input
 * @returns {{dispatch: Array<object>, decisions: Array<{workflow: string, job: string, slug: string, flakeScore: number, action: string, reason: string}>}}
 */
export function filterCandidates({
  candidates = [],
  threshold = CONFIG.FLAKE_THRESHOLD,
  cooldownDays = CONFIG.COOLDOWN_DAYS,
  maxAttempts = CONFIG.MAX_ATTEMPTS_PER_JOB,
  maxDispatches = CONFIG.MAX_DISPATCHES_PER_RUN,
  attemptsByJob = {},
  now = new Date(),
} = {}) {
  const dispatch = [];
  const decisions = [];
  for (const candidate of candidates) {
    const history = attemptsByJob[candidate.slug] ?? {};
    const budgetLeft = dispatch.length < maxDispatches;
    const decision = decideCandidate({
      candidate,
      history,
      threshold,
      cooldownDays,
      maxAttempts,
      budgetLeft,
      now,
    });
    decisions.push({
      workflow: candidate.workflow,
      job: candidate.job,
      slug: candidate.slug,
      flakeScore: candidate.flakeScore,
      ...decision,
    });
    if (decision.action === 'dispatch') dispatch.push(candidate);
  }
  return { dispatch, decisions };
}

/**
 * The per-candidate verdict. Split out of `filterCandidates` so each rule stays
 * a single readable line.
 * @returns {{action: 'dispatch'|'excluded'|'below-threshold'|'gave-up'|'in-flight'|'cooldown'|'infra'|'unlocalized'|'budget-spent', reason: string}}
 */
function decideCandidate({
  candidate,
  history,
  threshold,
  cooldownDays,
  maxAttempts,
  budgetLeft,
  now,
}) {
  if (isExcludedJob(candidate)) {
    return {
      action: 'excluded',
      reason: `${candidate.workflow} / ${candidate.job} is a release/publish/deploy job — a nondeterministic release is a human conversation, not a fixer's PR.`,
    };
  }
  if (candidate.flakeScore < threshold) {
    return {
      action: 'below-threshold',
      reason: `Flipped on ${candidate.flakeScore} distinct commit(s); threshold is ${threshold}. One flip is noise.`,
    };
  }
  if ((history.attempts ?? 0) >= maxAttempts) {
    return {
      action: 'gave-up',
      reason: `Already dispatched ${history.attempts} time(s) (MAX_ATTEMPTS_PER_JOB=${maxAttempts}) via ${fixBranch(candidate.slug)} — leaving this one for a human.`,
    };
  }
  if (history.openPrUrl) {
    return {
      action: 'in-flight',
      reason: `An open fix PR already addresses this job: ${history.openPrUrl}.`,
    };
  }
  const cooldown = cooldownReason({ history, cooldownDays, now, slug: candidate.slug });
  if (cooldown) return { action: 'cooldown', reason: cooldown };
  if (candidate.mitigatedInfra) {
    return {
      action: 'infra',
      reason: `Fully explained by a known infrastructure cause (${candidate.mitigatedInfra.label}). ${candidate.mitigatedInfra.note}`,
    };
  }
  if (!candidate.localized) {
    return {
      action: 'unlocalized',
      reason:
        candidate.localizationReason ??
        'No common failure signature across two flips — an intermittent job with unrelated causes is a digest entry, not a fix.',
    };
  }
  if (!budgetLeft) {
    return {
      action: 'budget-spent',
      reason: `MAX_DISPATCHES_PER_RUN reached — a wrong flaky-test fix is worse than none, so this waits for next week.`,
    };
  }
  return {
    action: 'dispatch',
    reason: `Flipped on ${candidate.flakeScore} distinct commits with a common failure signature — dispatching one fixer.`,
  };
}

/** The cooldown explanation, or `null` when the job is dispatchable again. */
function cooldownReason({ history, cooldownDays, now, slug }) {
  if (!history.lastDispatchAt) return null;
  // A merged fix ends the cooldown early: the previous attempt is resolved, so
  // a fresh flip is new information rather than a duplicate dispatch.
  if (history.lastMergedAt) return null;
  const age = daysSince(history.lastDispatchAt, now);
  if (age >= cooldownDays) return null;
  const remaining = Math.ceil(cooldownDays - age);
  return `Dispatched ${Math.floor(age)} day(s) ago on ${fixBranch(slug)} and no fix has merged — ${remaining} day(s) of COOLDOWN_DAYS=${cooldownDays} left.`;
}

/* ─────────────────────────── Step 3: localization ─────────────────────────── */

const ANSI = /\u001B\[[0-9;]*m/g;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s*/;

/** Lines worth keeping when looking for what two flips have in common. */
const INTERESTING_LINE =
  /(FAIL|✕|×|AssertionError|Error:|Timeout|expected|##\[error\]|EADDRINUSE|ECONNREFUSED)/i;

/**
 * Pull the interesting lines out of a job log: strip ANSI and the per-line
 * timestamp Actions prefixes, keep failure-ish lines, drop duplicates.
 * @param {string} logText
 * @param {{maxLines?: number}} [opts]
 * @returns {string[]}
 */
export function extractFailureLines(logText, { maxLines = 12 } = {}) {
  const seen = new Set();
  for (const raw of String(logText ?? '').split('\n')) {
    const line = raw.replace(ANSI, '').replace(TIMESTAMP, '').trim();
    if (!line || !INTERESTING_LINE.test(line)) continue;
    seen.add(line.slice(0, 300));
    if (seen.size >= maxLines) break;
  }
  return [...seen];
}

/**
 * Normalize a log line so two flips of the same failure compare equal:
 * durations, ports, PIDs, and line numbers differ every run.
 * @param {string} line
 * @returns {string}
 */
function normalizeLine(line) {
  return String(line)
    .replace(/\b\d+(\.\d+)?\s*(ms|s|m)\b/gi, '<dur>')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Step 3 — is the failure the SAME failure across flips? Requires at least two
 * excerpts and at least one normalized line they share. When two flips of one
 * job have nothing in common, that job is intermittent for unrelated reasons:
 * a digest entry, not a fix.
 * @param {Array<{runUrl?: string, lines?: string[]}>} excerpts
 * @returns {{localized: boolean, signature: string, reason: string}}
 */
export function localizeFlake(excerpts = []) {
  const usable = excerpts.filter((e) => Array.isArray(e?.lines) && e.lines.length > 0);
  if (usable.length < 2) {
    return {
      localized: false,
      signature: usable[0]?.lines?.[0] ?? '',
      reason: `Only ${usable.length} flip(s) yielded readable failure output; Step 3 needs the logs of at least two flips to name a failure mode.`,
    };
  }
  const [first, ...rest] = usable;
  /** normalized → the original line, so the digest shows real text */
  const candidateLines = new Map(first.lines.map((l) => [normalizeLine(l), l]));
  for (const excerpt of rest) {
    const theirs = new Set(excerpt.lines.map(normalizeLine));
    for (const key of [...candidateLines.keys()]) {
      if (!theirs.has(key)) candidateLines.delete(key);
    }
  }
  const common = [...candidateLines.values()];
  if (common.length === 0) {
    return {
      localized: false,
      signature: '',
      reason: `Read ${usable.length} flip logs and found no shared failure line — the flips have nothing in common, so this is not one fixable flake.`,
    };
  }
  return {
    localized: true,
    signature: common.slice(0, 5).join('\n'),
    reason: `${common.length} failure line(s) common to ${usable.length} flips of the same job.`,
  };
}

/* ──────────────────────────── Step 7: the digest ──────────────────────────── */

/** Human labels for `decideCandidate` actions, used as digest table values. */
const ACTION_LABEL = {
  dispatch: '🚀 dispatched',
  excluded: '⛔️ excluded',
  'below-threshold': '· sub-threshold',
  'gave-up': '🏳️ gave up',
  'in-flight': '⏳ fix in flight',
  cooldown: '🧊 cooldown',
  infra: '🏗️ known infra',
  unlocalized: '🤷 not localized',
  'budget-spent': '📆 deferred',
};

/** The per-day scan-coverage table, plus the truncation warning if any day short-changed us. */
function coverageSection(coverage) {
  const days = coverage?.days ?? [];
  const truncated = days.filter((d) => d.retrieved < d.totalCount);
  const rows = days
    .map(
      (d) =>
        `| \`${d.day}\` | ${d.retrieved} | ${d.totalCount} | ${d.retrieved < d.totalCount ? '⚠️ truncated' : 'complete'} |`
    )
    .join('\n');
  const warning = truncated.length
    ? `\n> ⚠️ **This scan was TRUNCATED on ${truncated.length} day(s)** (${truncated
        .map((d) => d.day)
        .join(
          ', '
        )}). Evidence from those days is missing, so the picture below is incomplete — an under-covered window can fake a quiet week. Do not read this as a clean scan.\n`
    : '\n> Coverage complete: every day returned as many runs as its `total_count`.\n';
  return `## Scan coverage

| Day (UTC) | Runs retrieved | \`total_count\` | Status |
| --------- | -------------- | -------------- | ------ |
${rows || '| _(no days scanned)_ | – | – | – |'}
${warning}
- Job logs read: **${coverage?.logReads ?? 0}** (cap ${coverage?.maxLogReads ?? CONFIG.MAX_LOG_READS})
- GitHub API calls: **${coverage?.apiCalls ?? 0}**`;
}

/** One candidate's digest block: score, verdict, and its evidence links. */
function candidateSection(decision, candidate) {
  const evidence = (candidate?.flips ?? [])
    .slice(0, 6)
    .map((f) => `  - \`${f.headSha.slice(0, 8)}\` — ${f.detail}${f.runUrl ? ` (${f.runUrl})` : ''}`)
    .join('\n');
  const signature = candidate?.signature
    ? `\n  - Common signature:\n\n    \`\`\`\n    ${candidate.signature.split('\n').join('\n    ')}\n    \`\`\`\n`
    : '';
  return `- **${candidate.workflow} / ${candidate.job}** — score **${decision.flakeScore}** (${(candidate.sources ?? []).join(', ') || 'no source'}) → ${ACTION_LABEL[decision.action] ?? decision.action}
  - ${decision.reason}
  - Registry key: \`${fixBranch(candidate.slug)}\`
${evidence || '  - _(no evidence links)_'}${signature}`;
}

/**
 * Step 7 — the full Markdown digest, overwritten each run. It always includes
 * the SUB-THRESHOLD tail: that tail is what shows whether residual flakiness is
 * one bad test or spread thin across many, and the weeks where nothing is
 * dispatched are exactly the weeks this output matters.
 * @param {{candidates?: Array<object>, decisions?: Array<object>, coverage?: object, dispatched?: Array<object>, now?: Date, windowDays?: number}} input
 * @returns {string} Markdown
 */
export function buildDigest({
  candidates = [],
  decisions = [],
  coverage = {},
  dispatched = [],
  now = new Date(),
  windowDays = CONFIG.WINDOW_DAYS,
} = {}) {
  const byKey = new Map(candidates.map((c) => [jobKey(c.workflow, c.job), c]));
  const above = decisions.filter((d) => d.action !== 'below-threshold');
  const below = decisions.filter((d) => d.action === 'below-threshold');
  const render = (list) =>
    list.map((d) => candidateSection(d, byKey.get(jobKey(d.workflow, d.job)) ?? d)).join('\n');

  const headline = dispatched.length
    ? dispatched
        .map(
          (c) => `🚀 Dispatched a fixer for **${c.workflow} / ${c.job}** (score ${c.flakeScore}).`
        )
        .join('\n')
    : '😌 **No dispatch this week.** An empty week is a valid outcome — dispatching nothing is better than dispatching a worker onto a job that is simply broken.';

  return `# Flaky CI Hunter digest — ${utcDay(now)}

Trailing window: **${windowDays} day(s)**. A flake here means one \`head_sha\`
producing two different outcomes; a job that merely fails often is not a flake
and is never dispatched.

${headline}

## Candidates at or above threshold (${above.length})

${above.length ? render(above) : '_None._'}

## Sub-threshold tail (${below.length})

Kept deliberately: this tail is how a human sees whether the residual flakiness
is one bad test or spread thin across many jobs.

${below.length ? render(below) : '_None._'}

${coverageSection(coverage)}
`;
}

/* ─────────────────────────── Step 6: dispatch brief ─────────────────────────── */

/**
 * Compose the fixer's brief. The banned-fix list is the point of this prompt:
 * this repo's standing policy is that a retry HIDES nondeterminism, so raising
 * a retry count is never an acceptable outcome of a dispatch.
 * @param {{workflow: string, job: string, slug: string, flakeScore: number, flips?: Array<object>, signature?: string, rootCauseHint?: string}} candidate
 * @param {{windowDays?: number}} [opts]
 * @returns {string}
 */
export function buildPrompt(candidate, { windowDays = CONFIG.WINDOW_DAYS } = {}) {
  const evidence = (candidate.flips ?? [])
    .slice(0, 6)
    .map((f) => `- ${f.runUrl || '(no run url)'} — ${f.detail}`)
    .join('\n');
  const branch = fixBranch(candidate.slug);

  return `# Fix one flaky CI job

Flaky job: **${candidate.workflow} / ${candidate.job}**. Flipped on ${candidate.flakeScore} distinct commits in the last ${windowDays} days.

## Evidence — same commit, different outcomes

${evidence || '- (no evidence links captured)'}

## Common failure signature

\`\`\`
${candidate.signature || '(no common signature captured)'}
\`\`\`

Suspected root cause: ${candidate.rootCauseHint || 'unknown — derive it from the signature above before you change anything.'}

## Your job

Make this test deterministic. Fix the underlying nondeterminism — fake the
timer, await the promise, isolate the port or fixture, remove the ordering
dependence, mock the clock.

This repo has an explicit policy in
\`.agents/skills/writing-slicc-tests/SKILL.md\` §"Retry Flaky Tests" (mirrored in
\`docs/development.md\` §"Test Timing and Flaky Retries"): **a retry hides
nondeterminism rather than fixing it.** Read that skill file before you start.
Therefore the following are NOT acceptable fixes and will be rejected:

- raising \`CI_RETRIES\` in \`vitest.config.ts\`, or any per-project \`retry\` count
  (only \`node-server\` and \`chrome-extension\` retry once; Playwright E2E retries
  twice; every other project retries zero times **by design**);
- adding \`test.retry(...)\`;
- adding a bare \`sleep\` / fixed delay;
- loosening or deleting an assertion;
- marking the test \`.skip\` / \`.todo\`;
- widening a timeout to paper over a race.

If the honest fix is one of those banned options — i.e. the nondeterminism is
genuinely external and irreducible — **stop and report back saying so instead of
pushing.** That is a useful answer, not a failure.

Verify by running the affected suite repeatedly — **at least 10 iterations** —
and confirming it passes every time. State the iteration count in the PR body.

## How to deliver

1. Create the branch **\`${branch}\`** off the default branch. That exact branch
   name is this automation's durable registry key: a future run reads
   \`${FIX_BRANCH_PREFIX}*\` pull requests to learn how many times this job has
   already been dispatched and when. Do not rename it.
2. Keep the change scoped to this one flake.
3. Open **exactly ONE** pull request, labelled \`${FIX_LABEL}\`. Do not merge it and
   do not assign reviewers.
4. Report back with the PR URL and the iteration count you verified with.
`;
}
