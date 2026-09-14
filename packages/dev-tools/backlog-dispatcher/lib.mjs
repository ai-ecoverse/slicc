export const CONFIG = {
  MAX_DISPATCHES_PER_RUN: 5,

  MAX_CANDIDATES_PER_SOURCE: 25,

  MAX_OPEN_PRS: 10,

  SETTLING_AGE_HOURS: 1,

  STALE_PR_DAYS: 7,
};

export const LABELS = {
  ready: 'backlog-ready',

  dispatched: 'backlog-dispatched',

  skipped: 'backlog-skipped',

  stale: 'backlog-stale',

  failed: 'cosmos-dispatch-failed',

  legacyDispatched: ['cosmos-dispatched'],

  legacySkipped: ['cosmos-skipped'],

  legacyFailed: ['cosmos-dispatch-failed'],
};

export const DECIDED_LABELS = [
  LABELS.ready,
  LABELS.dispatched,
  LABELS.skipped,
  LABELS.failed,
  ...LABELS.legacyDispatched,
  ...LABELS.legacySkipped,
  ...LABELS.legacyFailed,
];

export const DENYLIST_LABELS = ['question', 'wontfix', 'invalid', 'duplicate', 'help wanted'];

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

export const BRANCH_PREFIX = 'automation/backlog';

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

export const READY_CLASSES = [
  {
    id: 'debt',
    base: 100,
    labels: ['agentic-debt', 'debt'],

    pattern:
      /^(paranoia|necrophilia|entanglement|duplication|complicatification|drift|amnesia|cargo[- ]cult)\b/i,
  },
  { id: 'bug', base: 80, labels: ['bug'], pattern: /^(bug|fix)\(|^flaky test\b/i },
  { id: 'docs', base: 60, labels: ['documentation', 'area/docs'], pattern: /^docs?\(/i },
  { id: 'feat', base: 40, labels: ['enhancement'], pattern: /^(feat|test|chore|refactor)\(/i },
];

const NAMED_FILE_RE = /[\w./-]+\.(ts|tsx|mjs|js|json|md|swift|go|yml|yaml|sh|grit)\b/;

const CONCRETE_SYMPTOM_RE =
  /\b(throws?|error|times? out|hangs?|crashes?|returns? (the )?wrong|is (invisible|ignored|dropped|empty)|swallows?|off[- ]by[- ]one|regress\w*|does not|doesn't|never (fires|runs|resolves))\b/i;

const MAX_SCANNED_BODY_CHARS = 4000;

const HOUR_MS = 3_600_000;

export function labelNames(issue) {
  const raw = Array.isArray(issue?.labels) ? issue.labels : [];
  return raw
    .map((l) => String(typeof l === 'string' ? l : (l?.name ?? '')).toLowerCase())
    .filter((n) => n.length > 0);
}

function hoursSince(then, now) {
  const thenMs = new Date(then ?? '').getTime();
  const nowMs = new Date(now ?? Date.now()).getTime();
  if (Number.isNaN(thenMs) || Number.isNaN(nowMs)) return Number.POSITIVE_INFINITY;
  return (nowMs - thenMs) / HOUR_MS;
}

function daysSince(then, now) {
  return hoursSince(then, now) / 24;
}

export function issueBranch(number) {
  return `${BRANCH_PREFIX}/issue-${Number(number)}`;
}

export function isDispatcherPr(pr) {
  if (!pr) return false;
  const ref = String(pr.head?.ref ?? pr.headRef ?? '');
  if (ref.startsWith(`${BRANCH_PREFIX}/`)) return true;
  const labels = labelNames(pr);
  return labels.includes(LABELS.dispatched) || labels.includes(LABELS.legacyDispatched[0]);
}

function issueRefRe(number) {
  return new RegExp(`#${Number(number)}(?!\\d)`);
}

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

const reject = (code, reason) => ({ eligible: false, code, reason });
const ACCEPT = { eligible: true, code: 'eligible', reason: 'Passed every screening rule.' };

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

export function isCandidate(issue, opts = {}) {
  return screenIssue(issue, opts).eligible;
}

export function classifyIssue(issue) {
  const labels = labelNames(issue);
  const title = String(issue?.title ?? '');
  for (const cls of READY_CLASSES) {
    const byLabel = labels.some((l) => cls.labels.some((c) => l === c || l.startsWith(`${c}:`)));
    if (byLabel || cls.pattern.test(title)) return cls.id;
  }
  return 'other';
}

export function detectSmells(issue) {
  const text = [
    String(issue?.title ?? ''),
    String(issue?.body ?? '').slice(0, MAX_SCANNED_BODY_CHARS),
    labelNames(issue).join(' '),
  ].join('\n');
  return HARD_OVERRIDES.filter((o) => o.pattern.test(text)).map((o) => o.id);
}

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

  score -= Math.min(30, Math.floor(body.length / 500) * 3);
  score -= 25 * smells.length;
  return { score, class: cls, smells, namedFile };
}

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

export function dispatchBudget(input = {}) {
  const {
    openDispatcherPrs = 0,
    maxOpenPrs = CONFIG.MAX_OPEN_PRS,
    maxPerRun = CONFIG.MAX_DISPATCHES_PER_RUN,
  } = input;
  const headroom = maxOpenPrs - Math.max(0, Number(openDispatcherPrs) || 0);
  return Math.max(0, Math.min(maxPerRun, headroom));
}

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

export function buildMarker(kind, number) {
  const parsed = Number(number);
  return `<!-- backlog-${kind}:${Number.isFinite(parsed) ? parsed : String(number)} -->`;
}

export function formatRejections(rejected = []) {
  const list = Array.isArray(rejected) ? rejected : [];
  if (list.length === 0) return [];
  const lines = [`screened out ${list.length} issue(s):`];
  for (const [code, group] of groupBy(list, (r) => r.code)) {
    lines.push(`  - ${code} (${group.length}): ${group.map((r) => `#${r.number}`).join(' ')}`);
    for (const [reason, members] of groupBy(group, (r) => r.reason)) {
      const attributed =
        members.length === group.length ? '' : `${members.map((r) => `#${r.number}`).join(' ')} — `;
      lines.push(`      ${attributed}${reason}`);
    }
  }
  return lines;
}

function groupBy(items, keyOf) {
  const map = new Map();
  for (const item of items) {
    const key = keyOf(item);
    map.set(key, [...(map.get(key) ?? []), item]);
  }
  return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
}

function attribution(runUrl) {
  const link = runUrl ? `[Backlog Dispatcher](${runUrl})` : 'Backlog Dispatcher';
  return `<sup>🎫 ${link}</sup>`;
}

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

function rejectionTally(rejected) {
  const counts = new Map();
  for (const r of rejected) counts.set(r.code, (counts.get(r.code) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([code, n]) => `| \`${code}\` | ${n} |`)
    .join('\n');
}

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
