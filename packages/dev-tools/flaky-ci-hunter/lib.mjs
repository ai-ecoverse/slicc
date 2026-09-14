export const CONFIG = Object.freeze({
  WINDOW_DAYS: 7,

  MAX_LOG_READS: 6,

  FLAKE_THRESHOLD: 2,

  MAX_DISPATCHES_PER_RUN: 1,

  COOLDOWN_DAYS: 21,

  MAX_ATTEMPTS_PER_JOB: 2,

  MAX_ATTEMPT_RUN_READS: 40,

  MAX_MAIN_RUN_READS: 20,
});

export const FIX_BRANCH_PREFIX = 'automation/flaky-fix/';

export const FIX_LABEL = 'flaky-fix';

const MS_PER_DAY = 86_400_000;

const KEY_SEP = '\u0000';

const FAILING_CONCLUSIONS = new Set(['failure', 'timed_out']);

const PR_EVENTS = new Set(['pull_request', 'pull_request_target']);

const MAIN_EVENTS = new Set(['push', 'merge_group']);

export function isDefaultBranchRef(ref, defaultBranch = 'main') {
  if (ref == null) return true;
  const branch = String(ref);
  return branch === defaultBranch || branch.startsWith(`gh-readonly-queue/${defaultBranch}/`);
}

const SOURCE_RANK = { attempt: 2, 'main-regression': 1 };

export function jobKey(workflow, job) {
  return `${workflow}${KEY_SEP}${job}`;
}

export function utcDay(value) {
  const d = value instanceof Date ? value : new Date(value);
  return d.toISOString().slice(0, 10);
}

export function dayWindows(now, windowDays = CONFIG.WINDOW_DAYS) {
  const end = now instanceof Date ? now : new Date(now);
  const start = windowStart(end, windowDays);
  const endMidnight = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  const startMidnight = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const days = [];
  for (let t = startMidnight; t <= endMidnight; t += MS_PER_DAY) days.push(utcDay(new Date(t)));
  return days;
}

export function windowStart(now, windowDays = CONFIG.WINDOW_DAYS) {
  const count = Math.max(1, Math.floor(Number(windowDays) || CONFIG.WINDOW_DAYS));
  const end = now instanceof Date ? now : new Date(now);
  return new Date(end.getTime() - count * MS_PER_DAY);
}

export function withinWindow(runs = [], cutoff) {
  const floor = cutoff instanceof Date ? cutoff.getTime() : new Date(cutoff).getTime();
  if (!Number.isFinite(floor)) return [...runs];
  return runs.filter((run) => {
    const at = Date.parse(run?.created_at ?? '');
    return Number.isFinite(at) ? at >= floor : true;
  });
}

export function createdRangeParam(day) {
  return `created=${day}..${day}`;
}

export function findAttemptFlips(jobsByAttempt, meta = {}) {
  const { workflow = 'unknown', headSha = '', runUrl = '', runId } = meta;
  const attempts = Object.keys(jobsByAttempt ?? {})
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);

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

        jobId: prior.jobId,
        successJobId: job.id,
        detail: `attempt ${prior.attempt} ${prior.conclusion} → attempt ${attempt} success on ${headSha.slice(0, 8)}`,
      });

      firstFailure.delete(name);
    }
  }
  return flips;
}

export function findMainRegressionFlips({
  observations = [],
  corroboratedJobs = new Set(),
  defaultBranch = 'main',
} = {}) {
  const groups = new Map();
  for (const o of observations) {
    if (!o?.workflow || !o?.job || !o?.headSha) continue;
    const key = `${o.headSha}${KEY_SEP}${jobKey(o.workflow, o.job)}`;
    const group = groups.get(key) ?? { obs: o, prPass: null, mainFail: null };
    if (PR_EVENTS.has(o.event) && o.conclusion === 'success') group.prPass ??= o;
    const onMain = MAIN_EVENTS.has(o.event) && isDefaultBranchRef(o.branch, defaultBranch);
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

const EXCLUDED_WORKFLOWS = new Set([
  'release',
  'worker production deploy',
  'worker staging deploy',
]);

const EXCLUDED_JOB_PATTERN = /release|publish|deploy/i;

export function isExcludedJob({ workflow = '', job = '' } = {}) {
  if (EXCLUDED_WORKFLOWS.has(String(workflow).trim().toLowerCase())) return true;
  return EXCLUDED_JOB_PATTERN.test(String(job));
}

export function jobSlug(workflow, job) {
  const part = (s) =>
    String(s ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  const slug = [part(workflow), part(job)].filter(Boolean).join('--');
  return slug || 'unknown';
}

export function fixBranch(slug) {
  return `${FIX_BRANCH_PREFIX}${slug}`;
}

export function slugFromBranch(branch) {
  const ref = String(branch ?? '').replace(/^refs\/heads\//, '');
  if (!ref.startsWith(FIX_BRANCH_PREFIX)) return null;
  const slug = ref.slice(FIX_BRANCH_PREFIX.length).trim();
  return slug || null;
}

export function attemptsFromPulls(pulls = []) {
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

function daysSince(then, now) {
  return (now.getTime() - new Date(then).getTime()) / MS_PER_DAY;
}

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

function cooldownReason({ history, cooldownDays, now, slug }) {
  if (!history.lastDispatchAt) return null;

  if (history.lastMergedAt) return null;
  const age = daysSince(history.lastDispatchAt, now);
  if (age >= cooldownDays) return null;
  const remaining = Math.ceil(cooldownDays - age);
  return `Dispatched ${Math.floor(age)} day(s) ago on ${fixBranch(slug)} and no fix has merged — ${remaining} day(s) of COOLDOWN_DAYS=${cooldownDays} left.`;
}

const ANSI = /\u001B\[[0-9;]*m/g;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s*/;

const INTERESTING_LINE =
  /(FAIL|✕|×|AssertionError|Error:|Timeout|expected|##\[error\]|EADDRINUSE|ECONNREFUSED)/i;

const PLUMBING_LINE =
  /^(##\[error\])?\s*(one or more jobs failed|process completed with exit code|the (job|operation) was canceled|the run was canceled|echo "::error|::error::one or more jobs)/i;

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

function normalizeLine(line) {
  return String(line)
    .replace(/\b\d+(\.\d+)?\s*(ms|s|m)\b/gi, '<dur>')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

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

  if (common.every((line) => PLUMBING_LINE.test(line))) {
    return {
      localized: false,
      signature: common.slice(0, 5).join('\n'),
      reason: `The only lines shared by ${usable.length} flips are GitHub Actions plumbing ("job failed", "exit code"), naming no failure mode. This is what a gate/aggregator job looks like — it mirrors other jobs' flakiness rather than having its own.`,
    };
  }
  return {
    localized: true,
    signature: common.slice(0, 5).join('\n'),
    reason: `${common.length} failure line(s) common to ${usable.length} flips of the same job.`,
  };
}

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
3. Commit, then \`git push -u origin ${branch}\`.
4. Write two files instead of opening the pull request yourself:
   - the one-line PR title to the path in \`$PR_TITLE_FILE\` (a conventional-commit
     subject naming the root cause, e.g.
     \`fix(<scope>): <the nondeterminism you removed>\`);
   - the PR body to the path in \`$PR_BODY_FILE\`, stating the root cause, the
     evidence links above, and the iteration count you verified with.

   \`\`\`bash
   printf '%s\\n' "fix(<scope>): <root cause>" > "$PR_TITLE_FILE"
   cat > "$PR_BODY_FILE" <<'EOF'
   <root cause, evidence, iteration count>
   EOF
   \`\`\`

   **Do NOT run \`gh pr create\` and do not label anything.** A later,
   deterministic workflow step opens **exactly ONE** pull request from your pushed
   branch and those two files and applies the \`${FIX_LABEL}\` label. The PR must be
   authored by a token whose events trigger CI: a PR opened by your \`gh\` is
   authored by \`github-actions[bot]\`, and GitHub then queues every check on it as
   \`action_required\` until a human clicks "Approve and run" — worthless for a
   determinism fix nobody's CI ever runs. Do not merge it and do not assign
   reviewers.
5. Report back with the branch name and the iteration count you verified with. If
   the honest fix is one of the banned options, push NOTHING and write neither
   file — the step that opens the PR treats an unpushed branch as a clean no-op.
`;
}
