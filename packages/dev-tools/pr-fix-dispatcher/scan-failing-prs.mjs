#!/usr/bin/env node

import { appendFileSync } from 'node:fs';
import {
  attachWorkflowNames,
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
  prioritizeLogFetch,
  screenPr,
  summarizeChecks,
} from './lib.mjs';

const API = 'https://api.github.com';

const MAX_LOGS_PER_PR = 3;

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

async function request(method, path, { body, tolerate = [] } = {}) {
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
  if (!res.ok && !tolerate.includes(res.status)) {
    const text = await res.text().catch(() => '');

    const detail = text.replace(/\s+/g, ' ').trim().slice(0, 200);
    throw new Error(`${method} ${path} → ${res.status} ${res.statusText} ${detail}`);
  }
  return res;
}

async function gh(method, path, opts = {}) {
  const res = await request(method, path, opts);
  if (!res.ok) return null;
  if (opts.raw) return res.text();
  const text = await res.text();
  return text.trim() === '' ? null : JSON.parse(text);
}

async function ghWrite(method, path, opts = {}) {
  const res = await request(method, path, opts);
  return res.ok;
}

const ghGet = (path, opts) => gh('GET', path, opts);

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

async function readRunsForSha(sha) {
  const data = await ghGet(`/repos/${REPO}/actions/runs?head_sha=${sha}&per_page=100`);
  return data?.workflow_runs ?? [];
}

function jobIdFromDetailsUrl(url) {
  const match = /\/job\/(\d+)/.exec(String(url ?? ''));
  return match ? match[1] : null;
}

async function attachLogExcerpts(failing) {
  const ordered = prioritizeLogFetch(failing);
  let fetched = 0;
  for (const failure of ordered) {
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
  return ordered;
}

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

async function addLabel(number, label) {
  if (DRY_RUN) return;
  await ghWrite('POST', `/repos/${REPO}/issues/${number}/labels`, { body: { labels: [label] } });
}

async function removeLabel(number, label) {
  if (DRY_RUN) return;
  await ghWrite('DELETE', `/repos/${REPO}/issues/${number}/labels/${encodeURIComponent(label)}`, {
    tolerate: [404],
  });
}

async function postComment(number, body) {
  if (DRY_RUN) return;
  await ghWrite('POST', `/repos/${REPO}/issues/${number}/comments`, { body: { body } });
}

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

    const accepted = await ghWrite(
      'POST',
      `/repos/${REPO}/actions/runs/${run.id}/rerun-failed-jobs`,
      { tolerate: [403, 409, 404] }
    );
    if (accepted) rerun += 1;
  }
  return { attempted: failed.length, rerun };
}

const oneLine = (text, max = 200) =>
  String(text ?? '')
    .replace(/\s+/g, ' ')
    .replaceAll('${{', '$ {{')
    .trim()
    .slice(0, max);

async function evaluatePr(pr, now, targeted = false) {
  const base = {
    number: pr.number,
    title: pr.title,
    headRef: pr.head?.ref ?? '',
    headSha: pr.head?.sha ?? '',

    headRepo: pr.head?.repo?.full_name ?? null,
    labels: (pr.labels ?? []).map((l) => l.name),
  };
  if (!isAutomationPr(pr)) {
    return {
      pr: base,
      decision: screenPr({ pr, checks: { failing: [] }, repo: REPO }),
      failures: [],
      runs: [],
    };
  }

  const checks = await readChecks(base.headSha);

  const cheap = screenPr({
    pr: { ...base, user: pr.user },
    checks,
    markers: {},
    now,
    targeted,
    repo: REPO,
  });
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
    repo: REPO,
  });
  if (screened) return { pr: base, decision: screened, failures: checks.failing, runs: [] };

  const runs = await readRunsForSha(base.headSha);

  attachWorkflowNames(checks.failing, runs);
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
