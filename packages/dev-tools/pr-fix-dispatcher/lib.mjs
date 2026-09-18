export const CONFIG = {
  MAX_DISPATCHES_PER_RUN: 3,

  MAX_CANDIDATES: 50,

  MAX_OPEN_FIXES: 5,

  MAX_ATTEMPTS_PER_PR: 2,

  MAX_RERUNS_PER_SHA: 1,

  SETTLING_MINUTES: 20,

  HUMAN_ACTIVITY_MINUTES: 60,
};

export const LABELS = {
  dispatched: 'ci-fix-dispatched',
  skipped: 'ci-fix-skipped',
  failed: 'ci-fix-failed',
};

export const LABEL_COLORS = {
  [LABELS.dispatched]: '1d76db',
  [LABELS.skipped]: 'cccccc',
  [LABELS.failed]: 'b60205',
};

export const AUTOMATION_BRANCH_PREFIXES = ['automation/', 'renovate/', 'rum-fix/'];

export const DEPENDENCY_UPDATE_BRANCH_PREFIXES = ['renovate/'];

export const SELF_HEALING_LABELS = ['patched-dependency', 'formatter-bump', 'swift-pin'];

export const FAILING_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled']);

export const FAILING_STATUS_STATES = new Set(['failure', 'error']);

const PENDING_CHECK_STATUSES = new Set([
  'queued',
  'in_progress',
  'waiting',
  'requested',
  'pending',
]);

const DEPENDENCY_RESOLUTION_PATTERN =
  /ERESOLVE|unable to resolve dependency tree|no matching version found|peer dep|requires a peer of/i;

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
    category: 'engine-mismatch',
    pattern: /engine node is incompatible|EBADENGINE|unsupported engine/i,
  },

  { category: 'dependency-resolution', pattern: DEPENDENCY_RESOLUTION_PATTERN },
  {
    category: 'ci-config-change',
    pattern:
      /invalid workflow file|\.github\/workflows\/[\w.-]+\.ya?ml.*(error|invalid)|workflow is not valid/i,
  },
];

export const HARD_SKIP_JOB_PATTERN =
  /\b(release|publish|deploy|notariz|provision|migrate|migration|secrets?)\b/i;

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

export const CODE_SIGNATURES = [
  {
    category: 'debt-gate',
    pattern:
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
      /package-lock\.json|lock ?file (is )?out of (sync|date)|npm ci can only install|git diff --exit-code|generated file .* out of date|working tree is dirty|go mod tidy|go\.(mod|sum) (are|is) not tidy|missing go\.sum entry/i,
  },

  { category: 'dependency-resolution', pattern: DEPENDENCY_RESOLUTION_PATTERN },

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

export function isAutomationPr(pr) {
  if (!pr) return false;
  const authorType = String(pr.user?.type ?? '').toLowerCase();
  if (authorType === 'bot') return true;
  const ref = String(pr.head?.ref ?? pr.headRef ?? '');
  return AUTOMATION_BRANCH_PREFIXES.some((prefix) => ref.startsWith(prefix));
}

export function isDependencyUpdatePr(pr) {
  if (!pr) return false;
  const ref = String(pr.head?.ref ?? pr.headRef ?? '');
  return DEPENDENCY_UPDATE_BRANCH_PREFIXES.some((prefix) => ref.startsWith(prefix));
}

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

function matchSignature(table, text) {
  for (const entry of table) {
    if (entry.pattern.test(text)) return entry.category;
  }
  return null;
}

function bareCheckName(jobName) {
  return String(jobName ?? '')
    .trim()
    .replace(/^ci\s*\/\s*/i, '')
    .replace(/\s*\([^()]*\)\s*$/, '')
    .trim()
    .toLowerCase();
}

const CI_AGGREGATOR_JOBS = new Set(['ci', 'ci-stack']);

export function isCiAggregatorJob(jobName) {
  return CI_AGGREGATOR_JOBS.has(bareCheckName(jobName));
}

function isCiAggregatorNoise(jobName, logExcerpt) {
  if (!isCiAggregatorJob(jobName)) return false;
  return /one or more jobs failed or were cancelled/i.test(String(logExcerpt));
}

const JOB_NAME_CODE_CATEGORIES = {
  lint: 'lint',
  typecheck: 'types',
};

export const CODE_WORKFLOW_NAME = 'CI';

const NON_CODE_JOBS = new Set([
  'ci',
  'ci-stack',

  'changes',
]);

export function wellKnownCodeCategory(jobName) {
  const bare = bareCheckName(jobName);
  if (!bare || NON_CODE_JOBS.has(bare)) return null;
  if (JOB_NAME_CODE_CATEGORIES[bare]) return JOB_NAME_CODE_CATEGORIES[bare];
  if (bare.startsWith('swift-')) return 'build';
  return bare;
}

function codeVerdict(name, category) {
  return {
    kind: 'code',
    category,
    reason: `"${name}" failed in the code (${category}).`,
  };
}

export function prioritizeLogFetch(failing = []) {
  const list = Array.isArray(failing) ? [...failing] : [];
  return list.sort((a, b) => {
    const aAgg = isCiAggregatorJob(a.name ?? a.jobName);
    const bAgg = isCiAggregatorJob(b.name ?? b.jobName);
    return Number(aAgg) - Number(bAgg);
  });
}

export function classifyFailure(
  { jobName = '', logExcerpt = '' } = {},
  { dependencyUpdate = false } = {}
) {
  const name = String(jobName);
  const text = `${name}\n${String(logExcerpt)}`;

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

  const named = JOB_NAME_CODE_CATEGORIES[bareCheckName(name)];
  if (named) return codeVerdict(name, named);
  return {
    kind: 'unknown',
    category: null,
    reason: `"${name}" failed but no plausible cause could be named from its log.`,
  };
}

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

function runIdFromDetailsUrl(url) {
  const match = /\/actions\/runs\/(\d+)/.exec(String(url ?? ''));
  return match ? match[1] : null;
}

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

function isNamePromotable(failure) {
  if (!failure || failure.kind === 'status') return false;

  if (!('workflow' in failure)) return true;
  if (failure.workflow == null) return false;
  return String(failure.workflow).trim().toLowerCase() === CODE_WORKFLOW_NAME.toLowerCase();
}

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

export function buildSkipMarker(sha) {
  return `<!-- pr-fix-skip:${sha} -->`;
}

export function buildDispatchMarker(sha) {
  return `<!-- pr-fix-dispatch:${sha} -->`;
}

const SKIP_MARKER_RE = /<!--\s*pr-fix-skip:([0-9a-f]{7,40})\s*-->/gi;
const DISPATCH_MARKER_RE = /<!--\s*pr-fix-dispatch:([0-9a-f]{7,40})\s*-->/gi;

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

export function hasRerunForSha(runs = []) {
  return (Array.isArray(runs) ? runs : []).some(
    (run) => Number(run?.run_attempt ?? 1) > CONFIG.MAX_RERUNS_PER_SHA
  );
}

export function dispatchBudget({ openFixes = 0 } = {}) {
  const headroom = CONFIG.MAX_OPEN_FIXES - Math.max(0, Number(openFixes) || 0);
  return Math.max(0, Math.min(CONFIG.MAX_DISPATCHES_PER_RUN, headroom));
}

function minutesSince(then, now) {
  const thenMs = new Date(then ?? '').getTime();
  const nowMs = new Date(now ?? Date.now()).getTime();
  if (Number.isNaN(thenMs) || Number.isNaN(nowMs)) return Number.POSITIVE_INFINITY;
  return (nowMs - thenMs) / 60_000;
}

function describeForeignHead(pr, repo) {
  const stated = (pr.head != null && 'repo' in pr.head) || 'headRepo' in pr;
  if (!stated) return null;
  const headRepo = pr.head?.repo?.full_name ?? pr.headRepo ?? null;
  const baseRepo = repo ?? pr.base?.repo?.full_name ?? null;
  if (headRepo !== null && (!baseRepo || headRepo === baseRepo)) return null;
  return `Head branch lives in ${headRepo ?? 'a deleted fork'}, not ${baseRepo ?? 'this repository'} — the fixer can only push to branches in this repository.`;
}

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

const FAILURE_LINE = /error|fail|✕|✗|cannot|unable|denied|conflict|timed out|canceled|cancelled/i;

const CONTEXT_AFTER = 8;

const CONTEXT_BEFORE = 3;

export function extractLogExcerpt(log, maxChars = 2000) {
  const lines = String(log ?? '')
    .split(/\r?\n/)

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
