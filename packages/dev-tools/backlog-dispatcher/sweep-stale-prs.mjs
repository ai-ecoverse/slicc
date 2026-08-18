#!/usr/bin/env node
/*
 * Backlog Dispatcher — stale-PR sweep (I/O, deterministic, no Claude).
 *
 * Finds this dispatcher's own open pull requests that have been idle for at
 * least CONFIG.STALE_PR_DAYS, labels each `backlog-stale`, and posts ONE
 * comment asking a human to pick it up.
 *
 * IT NEVER CLOSES A PULL REQUEST. The Cosmos-era original did, which threw away
 * work whose only sin was waiting for review; the deliberate replacement policy
 * is "make it visible, let a human decide". It also never pushes, never merges,
 * never requests reviewers, and never touches a PR's title, body, or base.
 *
 * Idempotent: a PR already carrying `backlog-stale` is not selected, so the
 * comment is posted exactly once however many times the sweep runs.
 *
 * Env:
 *   REPO             owner/repo (falls back to GITHUB_REPOSITORY)   (required)
 *   GH_TOKEN         token with pull-requests + issues write        (required unless FIXTURE)
 *   DRY_RUN          "true" → report what it would do, write nothing
 *   RUN_URL          Actions run URL for the comment attribution
 *   BACKLOG_FIXTURE  path to `{ "prs": [...] }` — offline rehearsal, forces DRY_RUN
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { CONFIG, formatStaleComment, LABELS, selectStalePrs } from './lib.mjs';

const SCRIPT = 'backlog-stale-sweep';
const API = 'https://api.github.com';
const FIXTURE = (process.env.BACKLOG_FIXTURE ?? '').trim();
// A fixture run has no repository to write to, so it is a rehearsal by
// construction rather than by the operator remembering DRY_RUN.
const DRY_RUN = (process.env.DRY_RUN ?? '').trim() === 'true' || FIXTURE !== '';
const MAX_PAGES = 5;

function appendSummary(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  appendFileSync(file, `${markdown}\n`);
}

/** Low-level GitHub REST call. Throws a one-line error on an untolerated non-OK response. */
async function request(method, path, { body, tolerate = [] } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${process.env.GH_TOKEN}`,
      'user-agent': SCRIPT,
      'x-github-api-version': '2022-11-28',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok && !tolerate.includes(res.status)) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `${method} ${path} → ${res.status} ${res.statusText} ${text.replace(/\s+/g, ' ').trim().slice(0, 200)}`
    );
  }
  return res;
}

/** Read returning parsed JSON, or `null` for an empty/tolerated body. */
async function ghGet(path) {
  const res = await request('GET', path);
  const text = await res.text();
  return text.trim() === '' ? null : JSON.parse(text);
}

/**
 * Write that reports only whether GitHub accepted it and never parses a body:
 * some GitHub write endpoints answer 201 with an empty body, and `res.json()`
 * would then throw AFTER the write had already landed.
 */
async function ghWrite(method, path, opts) {
  const res = await request(method, path, opts);
  return res.ok;
}

async function readOpenPrs(repo) {
  if (FIXTURE) return JSON.parse(readFileSync(FIXTURE, 'utf8')).prs ?? [];
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const batch = await ghGet(
      `/repos/${repo}/pulls?state=open&per_page=100&page=${page}&sort=updated&direction=asc`
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

/** Label + comment one stale PR. Both writes go through the issues endpoints. */
async function markStale(repo, pr) {
  if (DRY_RUN) return;
  await ghWrite('POST', `/repos/${repo}/issues/${pr.number}/labels`, {
    body: { labels: [LABELS.stale] },
  });
  await ghWrite('POST', `/repos/${repo}/issues/${pr.number}/comments`, {
    body: { body: formatStaleComment(pr, { runUrl: process.env.RUN_URL ?? '' }) },
  });
}

function writeSummary(stale) {
  const rows =
    stale
      .map((p) => `| #${p.number} | \`${p.headRef}\` | ${Math.floor(p.idleDays)} |`)
      .join('\n') || '| — | _none idle_ | |';
  appendSummary(
    [
      `### 🎫 Backlog Dispatcher — stale sweep${DRY_RUN ? ' (dry run)' : ''}`,
      '',
      `Threshold: **${CONFIG.STALE_PR_DAYS} day(s)** idle. Labelled \`${LABELS.stale}\` and commented once. **Never closed.**`,
      '',
      '| PR | Head branch | Idle days |',
      '| --- | --- | --- |',
      rows,
    ].join('\n')
  );
}

async function main() {
  const repo = (process.env.REPO || process.env.GITHUB_REPOSITORY || '').trim();
  if (!repo && !FIXTURE) {
    console.error(`${SCRIPT}: REPO (or GITHUB_REPOSITORY) is required, e.g. owner/repo`);
    return 2;
  }
  if (!process.env.GH_TOKEN && !FIXTURE) {
    console.error(`${SCRIPT}: GH_TOKEN is required (or set BACKLOG_FIXTURE=<path> to rehearse)`);
    return 2;
  }

  const prs = await readOpenPrs(repo);
  const stale = selectStalePrs(prs, { now: new Date() });
  console.log(
    `${SCRIPT}: ${prs.length} open PR(s); ${stale.length} dispatcher-owned PR(s) idle >= ${CONFIG.STALE_PR_DAYS}d`
  );
  for (const pr of stale) {
    console.log(`  - #${pr.number} idle ${pr.idleDays.toFixed(1)}d — ${pr.title}`);
    await markStale(repo, pr);
  }
  writeSummary(stale);
  if (DRY_RUN) console.log(`${SCRIPT}: DRY RUN — no labels or comments were written`);
  return 0;
}

try {
  process.exit(await main());
} catch (err) {
  console.error(
    `${SCRIPT}: ${err instanceof Error ? (err.message.split('\n')[0] ?? '') : String(err)}`
  );
  process.exit(1);
}
