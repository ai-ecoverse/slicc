#!/usr/bin/env node
/*
 * AI-comment detection — orchestrator (I/O).
 *
 * Reads the GitHub event, gathers every contribution on the thread — for a PR
 * the body plus issue comments, review comments, and non-empty reviews; for an
 * issue the body plus its comments — classifies each via the cost-ordered
 * cascade in `lib.mjs`, and applies the thread label: `ai-generated` when every
 * contribution is bot/AI, `human-in-the-loop` when at least one is human. Only
 * this file does I/O — `gh` for GitHub, `fetch` for the Pangram async detection
 * API (used solely as the cascade's last resort).
 *
 * Env:
 *   GITHUB_EVENT_PATH   path to the event payload     (provided by Actions)
 *   GITHUB_REPOSITORY   owner/repo                     (provided by Actions)
 *   PANGRAM_API_KEY     Pangram x-api-key              (optional; skips fallback when unset)
 *   PANGRAM_BASE_URL    Pangram base URL               (default text.external-api.pangram.com)
 *   GH_TOKEN            token for `gh`                 (provided by Actions)
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { classifyComment, decideLabels } from './lib.mjs';

const REPO = process.env.GITHUB_REPOSITORY;
const PANGRAM_KEY = process.env.PANGRAM_API_KEY;
const PANGRAM_BASE = (
  process.env.PANGRAM_BASE_URL || 'https://text.external-api.pangram.com'
).replace(/\/$/, '');
const MIN_PANGRAM_CHARS = 50; // shorter text carries too little signal to spend a call on
const POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 30;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Read and parse the triggering event payload. */
function readEvent() {
  const path = process.env.GITHUB_EVENT_PATH;
  if (!path) throw new Error('GITHUB_EVENT_PATH is not set');
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Resolve the thread under classification: a pull request or an issue. Handles
 * pull_request / review events, issue_comment on either a PR or an issue, and
 * the issues event. Returns null when the event carries no thread.
 */
function resolveTarget(event) {
  if (event.pull_request?.number) return { number: event.pull_request.number, isPr: true };
  if (event.issue?.number) {
    return { number: event.issue.number, isPr: Boolean(event.issue.pull_request) };
  }
  return null;
}

/** `gh api` returning parsed JSON; falls back to [] on error. */
function ghJson(endpoint, fallback = []) {
  try {
    const out = execFileSync('gh', ['api', endpoint], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    return JSON.parse(out.trim() || 'null') ?? fallback;
  } catch (err) {
    console.warn(`⚠️  gh api ${endpoint} failed: ${err.message?.split('\n')[0]}`);
    return fallback;
  }
}

/** Normalize a GitHub PR/comment/review object into a contribution. */
function toContribution(obj) {
  return {
    login: obj.user?.login,
    type: obj.user?.type,
    body: obj.body ?? '',
    viaApp: Boolean(obj.performed_via_github_app),
  };
}

/** Gather a PR's body plus every comment and non-empty review. */
function gatherPrContributions(number) {
  const pr = ghJson(`repos/${REPO}/pulls/${number}`, null);
  if (!pr) throw new Error(`could not fetch PR #${number}`);
  const issueComments = ghJson(`repos/${REPO}/issues/${number}/comments?per_page=100`);
  const reviewComments = ghJson(`repos/${REPO}/pulls/${number}/comments?per_page=100`);
  const reviews = ghJson(`repos/${REPO}/pulls/${number}/reviews?per_page=100`);
  const contributions = [
    toContribution(pr),
    ...issueComments.map(toContribution),
    ...reviewComments.map(toContribution),
    ...reviews.filter((r) => (r.body ?? '').trim()).map(toContribution),
  ].filter((c) => (c.body ?? '').trim() || c.login);
  return { thread: pr, contributions };
}

/** Gather an issue's body plus its comments (issues have no reviews). */
function gatherIssueContributions(number) {
  const issue = ghJson(`repos/${REPO}/issues/${number}`, null);
  if (!issue) throw new Error(`could not fetch issue #${number}`);
  const comments = ghJson(`repos/${REPO}/issues/${number}/comments?per_page=100`);
  const contributions = [toContribution(issue), ...comments.map(toContribution)].filter(
    (c) => (c.body ?? '').trim() || c.login
  );
  return { thread: issue, contributions };
}

/**
 * Pangram async detection: create a task, poll until it settles, return the
 * result object (consumed by `interpretPangram`). Returns null when Pangram is
 * unconfigured, the text is too short, or the call fails — the cascade then
 * defaults the contribution to human.
 */
async function pangramDetect(text) {
  if (!PANGRAM_KEY || (text ?? '').trim().length < MIN_PANGRAM_CHARS) return null;
  const headers = { 'Content-Type': 'application/json', 'x-api-key': PANGRAM_KEY };
  try {
    const created = await fetch(`${PANGRAM_BASE}/task`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text, public_dashboard_link: false }),
    });
    if (!created.ok) return null;
    const { task_id: taskId } = await created.json();
    if (!taskId) return null;
    for (let i = 0; i < MAX_POLLS; i += 1) {
      await sleep(POLL_INTERVAL_MS);
      const res = await fetch(`${PANGRAM_BASE}/task/${taskId}`, { headers });
      if (!res.ok) continue;
      const data = await res.json();
      if (data.stage === 'STAGE_SUCCESS' || data.stage === 'STAGE_FAILED') return data;
    }
  } catch (err) {
    console.warn(`⚠️  Pangram detection failed: ${err.message?.split('\n')[0]}`);
  }
  return null;
}

/** Apply the decided labels, only adding/removing where it changes state. */
function applyLabels(number, isPr, current, { add, remove }) {
  const toAdd = add.filter((l) => !current.includes(l));
  const toRemove = remove.filter((l) => current.includes(l));
  if (toAdd.length === 0 && toRemove.length === 0) {
    console.log('✅ Labels already correct; nothing to change.');
    return;
  }
  const args = [isPr ? 'pr' : 'issue', 'edit', String(number), '-R', REPO];
  for (const l of toAdd) args.push('--add-label', l);
  for (const l of toRemove) args.push('--remove-label', l);
  execFileSync('gh', args, { encoding: 'utf8' });
  console.log(`🏷️  +[${toAdd.join(', ')}] -[${toRemove.join(', ')}]`);
}

async function main() {
  const event = readEvent();
  const target = resolveTarget(event);
  if (!target) {
    console.log('No PR or issue thread on this event; nothing to label.');
    return;
  }
  const { number, isPr } = target;
  const { thread, contributions } = isPr
    ? gatherPrContributions(number)
    : gatherIssueContributions(number);
  const bodies = contributions.map((c) => c.body);
  const verdicts = [];
  for (let i = 0; i < contributions.length; i += 1) {
    const corpus = bodies.filter((_, j) => j !== i);
    const v = await classifyComment({ ...contributions[i], corpus, pangram: pangramDetect });
    verdicts.push(v);
    console.log(
      `   ${v.isHuman ? '🧑 human' : '🤖 ai/bot'} via ${v.method} — @${contributions[i].login}`
    );
  }
  const current = (thread.labels || []).map((l) => l.name);
  applyLabels(number, isPr, current, decideLabels(verdicts));
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
