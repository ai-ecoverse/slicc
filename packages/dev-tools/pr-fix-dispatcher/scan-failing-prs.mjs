#!/usr/bin/env node
/*
 * PR Fix Dispatcher — orchestrator (I/O).
 *
 * Scans open pull requests, keeps the routine automation-authored ones whose CI
 * is failing, and asks `decidePrAction` (pure, unit-tested in `lib.mjs`) which
 * of three paths each takes. The two deterministic paths are executed here:
 *
 *   • re-run  → POST /actions/runs/{id}/rerun-failed-jobs for the SHA's failed
 *               runs. No label, no comment — a re-run is already visible in the
 *               checks UI, and the next tick reads its outcome.
 *   • skip    → apply `ci-fix-skipped` + ONE comment carrying the durable
 *               `<!-- pr-fix-skip:<sha> -->` marker.
 *   • dispatch → apply `ci-fix-dispatched`, drop `ci-fix-skipped`, post the
 *               `<!-- pr-fix-dispatch:<sha> -->` marker comment, and queue the
 *               PR for the workflow's Claude fixer job.
 *
 * The only non-label, non-comment write this tool performs is
 * `rerun-failed-jobs`. It never re-runs a whole run, never cancels, never
 * merges, never closes, never pushes, and never edits a PR's title, body, base,
 * draft state, assignees, or reviewers.
 *
 * Env:
 *   REPO           owner/repo                                   (required)
 *   GH_TOKEN       token for the GitHub API                      (required)
 *   DRY_RUN        "true" → decide and report, perform no write  (default false)
 *   MAX_DISPATCHES optional override of CONFIG.MAX_DISPATCHES_PER_RUN
 *   PR_NUMBER      scan ONLY this PR (workflow_dispatch testing). Waives the
 *                  settling window and the recent-human-activity wait, since an
 *                  operator naming a PR has nobody to yield to; every other
 *                  guard (automation authorship, self-healing labels, markers,
 *                  hard overrides, budget) still applies.
 *
 * Writes `queue` (compact single-line JSON array), `has_dispatch`, and
 * `dispatch_count` to $GITHUB_OUTPUT, plus a candidate table to
 * $GITHUB_STEP_SUMMARY.
 */
import { appendFileSync } from 'node:fs';
import {
  buildDispatchMarker,
  buildSkipMarker,
  CONFIG,
  decidePrAction,
  dispatchBudget,
  extractLogExcerpt,
  formatFailuresForMatrix,
  hasRerunForSha,
  isAutomationPr,
  LABELS,
  parseMarkers,
  screenPr,
  summarizeChecks,
} from './lib.mjs';

const API = 'https://api.github.com';
/** Failing checks whose logs we pull per PR. Logs are big; the excerpt is what matters. */
const MAX_LOGS_PER_PR = 3;
/** Upper bound on dispatched-label PRs inspected when computing the open-fix budget. */
const MAX_OPEN_FIX_PROBES = 20;

const DRY_RUN = (process.env.DRY_RUN ?? '').trim() === 'true';

function requireEnv(name) {
  const value = (process.env[name] ?? '').trim();
  if (!value) {
    console.error(`❌ Missing required env var ${name}.`);
    process.exit(2);
  }
  return value;
}

const REPO = requireEnv('REPO');
const TOKEN = requireEnv('GH_TOKEN');

/** GitHub REST request. Throws a one-line error on a non-OK response. */
async function gh(method, path, { body, raw = false, tolerate = [] } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'slicc-pr-fix-dispatcher',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    if (tolerate.includes(res.status)) return null;
    const text = await res.text().catch(() => '');
    // Collapse the body onto one line: the top-level handler prints only the
    // first line of the message and GitHub's error JSON is multi-line, so a raw
    // body would hide the actual reason.
    const detail = text.replace(/\s+/g, ' ').trim().slice(0, 200);
    throw new Error(`${method} ${path} → ${res.status} ${res.statusText} ${detail}`);
  }
  if (raw) return res.text();
  if (res.status === 204) return null;
  return res.json();
}

const ghGet = (path, opts) => gh('GET', path, opts);

/** GET every page of a list endpoint (per_page=100), stopping at `maxPages`. */
async function ghGetAll(path, maxPages = 5) {
  const joiner = path.includes('?') ? '&' : '?';
  const all = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const batch = await ghGet(`${path}${joiner}per_page=100&page=${page}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

const isBotActor = (actor) =>
  String(actor?.type ?? '').toLowerCase() === 'bot' || String(actor?.login ?? '').endsWith('[bot]');

function setOutput(key, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

function appendSummary(text) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** Read the head SHA's CI verdict from both the check-runs and the statuses API. */
async function readChecks(sha) {
  const [checkRuns, combined] = await Promise.all([
    ghGet(`/repos/${REPO}/commits/${sha}/check-runs?per_page=100&filter=latest`),
    ghGet(`/repos/${REPO}/commits/${sha}/status?per_page=100`),
  ]);
  return summarizeChecks({
    checkRuns: checkRuns?.check_runs ?? [],
    statuses: combined?.statuses ?? [],
  });
}

/**
 * Newest non-bot comment / review / push timestamp on the PR, or null. This is
 * the "a human is on it" signal; the head commit stands in for "pushed to the
 * branch" since the last push is what produced the head SHA.
 */
async function readLatestHumanActivity(pr) {
  const [comments, reviews, headCommit] = await Promise.all([
    ghGetAll(`/repos/${REPO}/issues/${pr.number}/comments`, 3),
    ghGetAll(`/repos/${REPO}/pulls/${pr.number}/reviews`, 3),
    ghGet(`/repos/${REPO}/commits/${pr.head.sha}`, { tolerate: [404, 422] }),
  ]);

  const stamps = [];
  for (const comment of comments) {
    if (!isBotActor(comment.user)) stamps.push(comment.created_at);
  }
  for (const review of reviews) {
    if (!isBotActor(review.user)) stamps.push(review.submitted_at);
  }
  if (headCommit && !isBotActor(headCommit.author) && !isBotActor(headCommit.committer)) {
    stamps.push(headCommit.commit?.committer?.date ?? headCommit.commit?.author?.date);
  }
  const newest = stamps.filter(Boolean).sort().pop();
  return { latestHumanActivityAt: newest ?? null, comments };
}

/** Actions runs for a head SHA (used for both `run_attempt` and the re-run targets). */
async function readRunsForSha(sha) {
  const data = await ghGet(`/repos/${REPO}/actions/runs?head_sha=${sha}&per_page=100`);
  return data?.workflow_runs ?? [];
}

/** Job id embedded in a check-run's `details_url` (…/actions/runs/<run>/job/<job>). */
function jobIdFromDetailsUrl(url) {
  const match = /\/job\/(\d+)/.exec(String(url ?? ''));
  return match ? match[1] : null;
}

/** Attach a bounded log excerpt to each failing check that has a fetchable job log. */
async function attachLogExcerpts(failing) {
  let fetched = 0;
  for (const failure of failing) {
    if (failure.kind === 'status') {
      failure.logExcerpt = String(failure.description ?? '');
      continue;
    }
    const jobId = jobIdFromDetailsUrl(failure.detailsUrl);
    if (!jobId || fetched >= MAX_LOGS_PER_PR) {
      failure.logExcerpt = '';
      continue;
    }
    fetched += 1;
    const log = await ghGet(`/repos/${REPO}/actions/jobs/${jobId}/logs`, {
      raw: true,
      tolerate: [403, 404, 410],
    });
    failure.logExcerpt = log ? extractLogExcerpt(log) : '';
  }
  return failing;
}

/**
 * Open-fix budget input: open PRs carrying the dispatched label whose head SHA
 * is still failing. Derived live — no stored counter.
 */
async function countOpenFixes() {
  const issues = await ghGetAll(
    `/repos/${REPO}/issues?state=open&labels=${encodeURIComponent(LABELS.dispatched)}`,
    1
  );
  const prs = issues.filter((issue) => issue.pull_request).slice(0, MAX_OPEN_FIX_PROBES);
  let open = 0;
  for (const issue of prs) {
    const pr = await ghGet(`/repos/${REPO}/pulls/${issue.number}`, { tolerate: [404] });
    if (!pr) continue;
    const checks = await readChecks(pr.head.sha);
    if (checks.failing.length > 0) open += 1;
  }
  return open;
}

// ── Writes ───────────────────────────────────────────────────────────────────

async function addLabel(number, label) {
  if (DRY_RUN) return;
  await gh('POST', `/repos/${REPO}/issues/${number}/labels`, { body: { labels: [label] } });
}

/**
 * Remove one label. Uses the dedicated `DELETE .../labels/{name}` endpoint
 * rather than PUTting the full list back: a PUT would clobber any label added
 * concurrently by another workflow (this repo's reconcilers relabel PRs), while
 * DELETE touches only the one label. A 404 (label not present) is expected and
 * tolerated.
 */
async function removeLabel(number, label) {
  if (DRY_RUN) return;
  await gh('DELETE', `/repos/${REPO}/issues/${number}/labels/${encodeURIComponent(label)}`, {
    tolerate: [404],
  });
}

async function postComment(number, body) {
  if (DRY_RUN) return;
  await gh('POST', `/repos/${REPO}/issues/${number}/comments`, { body: { body } });
}

/** Re-run only the failed jobs of every failed run for this SHA. */
async function rerunFailedJobs(sha, runs) {
  const failed = runs.filter((run) =>
    ['failure', 'cancelled', 'timed_out'].includes(String(run.conclusion ?? ''))
  );
  let rerun = 0;
  for (const run of failed) {
    if (DRY_RUN) {
      rerun += 1;
      continue;
    }
    // 403 = run too old to re-run, 409 = already re-running. Both are fine.
    const res = await gh('POST', `/repos/${REPO}/actions/runs/${run.id}/rerun-failed-jobs`, {
      tolerate: [403, 409, 404],
    });
    if (res !== null) rerun += 1;
  }
  return { attempted: failed.length, rerun };
}

// ── Per-PR pipeline ──────────────────────────────────────────────────────────

/** Sanitize a value that will be interpolated into a workflow matrix + prompt. */
const oneLine = (text, max = 200) =>
  String(text ?? '')
    .replace(/\s+/g, ' ')
    .replaceAll('${{', '$ {{')
    .trim()
    .slice(0, max);

/**
 * Decide one PR. Returns the decision plus everything the caller needs to act
 * on it. Cheap reads first; job logs and run history only for PRs that survive
 * the Step-4 screen.
 */
async function evaluatePr(pr, now, targeted = false) {
  const base = {
    number: pr.number,
    title: pr.title,
    headRef: pr.head?.ref ?? '',
    headSha: pr.head?.sha ?? '',
    labels: (pr.labels ?? []).map((l) => l.name),
  };
  if (!isAutomationPr(pr)) {
    return {
      pr: base,
      decision: screenPr({ pr, checks: { failing: [] } }),
      failures: [],
      runs: [],
    };
  }

  const checks = await readChecks(base.headSha);
  // First screen without the expensive reads. Everything it can decide (green,
  // still running, self-healing label, settling window) is independent of the
  // marker comments and human-activity data, so a hit here is final.
  const cheap = screenPr({ pr: { ...base, user: pr.user }, checks, markers: {}, now, targeted });
  if (cheap) return { pr: base, decision: cheap, failures: checks.failing, runs: [] };

  const { latestHumanActivityAt, comments } = await readLatestHumanActivity(pr);
  const markers = parseMarkers(comments);
  const screened = screenPr({
    pr: { ...base, user: pr.user },
    checks,
    markers,
    latestHumanActivityAt,
    now,
    targeted,
  });
  if (screened) return { pr: base, decision: screened, failures: checks.failing, runs: [] };

  const runs = await readRunsForSha(base.headSha);
  const failures = await attachLogExcerpts(checks.failing);
  const decision = decidePrAction({
    pr: { ...base, user: pr.user },
    checks: { ...checks, failing: failures },
    markers,
    latestHumanActivityAt,
    alreadyRerunSha: hasRerunForSha(runs),
    now,
    targeted,
  });
  return { pr: base, decision, failures, runs };
}

/** Execute the re-run or skip side of a decision. Dispatches are queued, not executed. */
async function actOn({ pr, decision, failures, runs }) {
  if (decision.action === 'rerun') {
    const { attempted, rerun } = await rerunFailedJobs(pr.headSha, runs);
    return `re-ran ${rerun}/${attempted} failed run(s)`;
  }
  if (decision.action === 'skip') {
    if (!decision.announce) return 'dropped silently';
    await addLabel(pr.number, LABELS.skipped);
    await postComment(
      pr.number,
      [
        `🧊 **PR Fix Dispatcher — skipping this one.** ${decision.reason}`,
        '',
        'No fixer was dispatched and no jobs were re-run. Pushing a new commit makes this PR eligible again.',
        buildSkipMarker(pr.headSha),
      ].join('\n')
    );
    return 'skipped (labelled + commented)';
  }
  // dispatch
  await addLabel(pr.number, LABELS.dispatched);
  await removeLabel(pr.number, LABELS.skipped);
  await postComment(
    pr.number,
    [
      `🔧 **PR Fix Dispatcher — dispatching a fixer.** ${decision.reason}`,
      '',
      `Failing: ${oneLine(failures.map((f) => f.name).join(', '), 300) || 'unknown'}`,
      buildDispatchMarker(pr.headSha),
    ].join('\n')
  );
  return 'dispatched';
}

function writeSummary(rows, budget, openFixes) {
  appendSummary('## PR Fix Dispatcher\n');
  appendSummary(
    `Candidates scanned: **${rows.length}** · open fixes in flight: **${openFixes}** · dispatch budget: **${budget}**${DRY_RUN ? ' · **DRY RUN**' : ''}\n`
  );
  appendSummary('| PR | Head branch | Path | Reason |');
  appendSummary('| --- | --- | --- | --- |');
  for (const row of rows) {
    appendSummary(
      `| #${row.pr.number} | \`${row.pr.headRef}\` | ${row.decision.action}${row.decision.announce === false && row.decision.action === 'skip' ? ' (silent)' : ''} | ${row.decision.reason.replaceAll('|', '\\|')} |`
    );
  }
}

async function main() {
  const now = new Date();
  // A single named PR (workflow_dispatch) or the routine sweep of open PRs.
  const targetNumber = (process.env.PR_NUMBER ?? '').trim();
  let prs;
  if (targetNumber) {
    console.log(`🔎 Targeted scan of ${REPO}#${targetNumber} (settling waits waived)…`);
    const pr = await ghGet(`/repos/${REPO}/pulls/${targetNumber}`);
    prs = [pr];
  } else {
    console.log(`🔎 Scanning up to ${CONFIG.MAX_CANDIDATES} open PR(s) in ${REPO}…`);
    prs = await ghGet(
      `/repos/${REPO}/pulls?state=open&per_page=${CONFIG.MAX_CANDIDATES}&sort=updated&direction=desc`
    );
  }
  if (!Array.isArray(prs)) throw new Error('Unexpected response listing pull requests.');

  const evaluated = [];
  for (const pr of prs) {
    evaluated.push(await evaluatePr(pr, now, Boolean(targetNumber)));
  }

  const openFixes = await countOpenFixes();
  const maxDispatches = Number(process.env.MAX_DISPATCHES) || CONFIG.MAX_DISPATCHES_PER_RUN;
  const budget = Math.min(dispatchBudget({ openFixes }), maxDispatches);

  // Newest-updated first (the listing order). Dispatches are capped; re-runs and
  // skips are not. Over-budget dispatches are left untouched — no label, no
  // comment — so the next tick can pick them up.
  let spent = 0;
  const queue = [];
  for (const row of evaluated) {
    if (row.decision.action === 'dispatch') {
      if (spent >= budget) {
        row.decision = {
          ...row.decision,
          action: 'skip',
          announce: false,
          reason: `${row.decision.reason} (deferred: dispatch budget of ${budget} spent this tick)`,
        };
      } else {
        spent += 1;
      }
    }
    row.outcome = await actOn(row);
    if (row.decision.action === 'dispatch') {
      queue.push({
        number: row.pr.number,
        headRef: row.pr.headRef,
        headSha: row.pr.headSha,
        title: oneLine(row.pr.title),
        failures: formatFailuresForMatrix(row.failures),
      });
    }
    console.log(`   • #${row.pr.number} ${row.decision.action} — ${row.decision.reason}`);
  }

  writeSummary(evaluated, budget, openFixes);
  setOutput('queue', JSON.stringify(queue));
  setOutput('has_dispatch', queue.length > 0 ? 'true' : 'false');
  setOutput('dispatch_count', String(queue.length));
  console.log(
    `\n${DRY_RUN ? '🧪 DRY RUN — no writes performed. ' : ''}Queued ${queue.length} fixer dispatch(es) (budget ${budget}, ${openFixes} fix(es) already open).`
  );
}

main().catch((err) => {
  console.error(`❌ PR Fix Dispatcher scan failed: ${err.message?.split('\n')[0] ?? err}`);
  process.exit(1);
});
