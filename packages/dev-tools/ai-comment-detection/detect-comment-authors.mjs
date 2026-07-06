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
 * `human-in-the-loop` is sticky, so when the thread already carries that label
 * we exit before gathering comments or calling Pangram — there is nothing a new
 * contribution could change.
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
import {
  classifyComment,
  decideLabels,
  HUMAN_IN_THE_LOOP_LABEL,
  isRetryablePangramStatus,
  isThreadSettledHuman,
} from './lib.mjs';

const REPO = process.env.GITHUB_REPOSITORY;
const PANGRAM_KEY = process.env.PANGRAM_API_KEY;
const PANGRAM_BASE = (
  process.env.PANGRAM_BASE_URL || 'https://text.external-api.pangram.com'
).replace(/\/$/, '');
const MIN_PANGRAM_CHARS = 50; // shorter text carries too little signal to spend a call on
const POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 30;
const PANGRAM_POST_ATTEMPTS = 3; // retry the submit on transient 429/5xx before giving up
const PANGRAM_RETRY_BASE_MS = 1000; // linear backoff base between POST retries

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

/** `gh api` returning parsed JSON; falls back on error. */
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

/**
 * `gh api --paginate` over a list endpoint, returning every page flattened into
 * a single array. Unlike `ghJson` this **throws** on failure instead of
 * returning a partial list: a dropped page (rate limit, transient error,
 * missing scope) would silently hide human contributions and could mislabel the
 * thread `ai-generated`, so the run must fail closed. `--slurp` yields one array
 * per page; flatten them. Without `--paginate` only the first 100 items are read.
 */
function ghList(endpoint) {
  const out = execFileSync('gh', ['api', '--paginate', '--slurp', endpoint], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const pages = JSON.parse(out.trim() || '[]');
  return Array.isArray(pages) ? pages.flat() : [];
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

/** Gather a PR's body plus every comment and non-empty review (all pages). */
function gatherPrContributions(number, pr) {
  const issueComments = ghList(`repos/${REPO}/issues/${number}/comments?per_page=100`);
  const reviewComments = ghList(`repos/${REPO}/pulls/${number}/comments?per_page=100`);
  const reviews = ghList(`repos/${REPO}/pulls/${number}/reviews?per_page=100`);
  return [
    toContribution(pr),
    ...issueComments.map(toContribution),
    ...reviewComments.map(toContribution),
    ...reviews.filter((r) => (r.body ?? '').trim()).map(toContribution),
  ].filter((c) => (c.body ?? '').trim() || c.login);
}

/** Gather an issue's body plus its comments, all pages (issues have no reviews). */
function gatherIssueContributions(number, issue) {
  const comments = ghList(`repos/${REPO}/issues/${number}/comments?per_page=100`);
  return [toContribution(issue), ...comments.map(toContribution)].filter(
    (c) => (c.body ?? '').trim() || c.login
  );
}

/**
 * Submit a Pangram detection task, retrying transient failures. Returns the
 * task id, or null when the submit is unrecoverable. Every non-2xx status is
 * logged with its code so a silent downgrade to the human default (which then
 * sticks the `human-in-the-loop` label) is diagnosable from the Actions log —
 * distinguishing "service unavailable" from a genuine "not AI" verdict. Only
 * transient 429/5xx are retried; terminal 4xx (bad key, no credits, invalid
 * input) fail fast.
 */
async function createPangramTask(headers, payload) {
  for (let attempt = 1; attempt <= PANGRAM_POST_ATTEMPTS; attempt += 1) {
    try {
      const created = await fetch(`${PANGRAM_BASE}/task`, {
        method: 'POST',
        headers,
        body: payload,
      });
      if (created.ok) {
        const { task_id: taskId } = await created.json();
        if (taskId) return taskId;
        console.warn(
          '⚠️  Pangram POST /task returned 2xx without a task_id; treating as unavailable.'
        );
        return null;
      }
      const retryable = isRetryablePangramStatus(created.status);
      console.warn(
        `⚠️  Pangram POST /task → HTTP ${created.status}` +
          (retryable
            ? ` (attempt ${attempt}/${PANGRAM_POST_ATTEMPTS})`
            : ' (terminal; not retrying)')
      );
      if (!retryable) return null;
    } catch (err) {
      console.warn(
        `⚠️  Pangram POST /task failed: ${err.message?.split('\n')[0]} (attempt ${attempt}/${PANGRAM_POST_ATTEMPTS})`
      );
    }
    if (attempt < PANGRAM_POST_ATTEMPTS) await sleep(PANGRAM_RETRY_BASE_MS * attempt);
  }
  return null;
}

/**
 * Pangram async detection: create a task, poll until it settles, return the
 * result object (consumed by `interpretPangram`). Returns null when Pangram is
 * unconfigured, the text is too short, or the call fails — the cascade then
 * defaults the contribution to human. Failures are logged with their HTTP
 * status so a transient outage is visible rather than silently mislabelling.
 */
async function pangramDetect(text) {
  if (!PANGRAM_KEY || (text ?? '').trim().length < MIN_PANGRAM_CHARS) return null;
  const headers = { 'Content-Type': 'application/json', 'x-api-key': PANGRAM_KEY };
  const payload = JSON.stringify({ text, public_dashboard_link: false });
  const taskId = await createPangramTask(headers, payload);
  if (!taskId) return null;
  for (let i = 0; i < MAX_POLLS; i += 1) {
    await sleep(POLL_INTERVAL_MS);
    try {
      const res = await fetch(`${PANGRAM_BASE}/task/${taskId}`, { headers });
      if (!res.ok) {
        console.warn(`⚠️  Pangram GET /task/${taskId} → HTTP ${res.status}; retrying poll.`);
        continue;
      }
      const data = await res.json();
      if (data.stage === 'STAGE_SUCCESS' || data.stage === 'STAGE_FAILED') return data;
    } catch (err) {
      console.warn(`⚠️  Pangram poll failed: ${err.message?.split('\n')[0]}; retrying poll.`);
    }
  }
  console.warn(
    `⚠️  Pangram task ${taskId} did not settle in ${MAX_POLLS} polls; treating as unavailable.`
  );
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
  const thread = isPr
    ? ghJson(`repos/${REPO}/pulls/${number}`, null)
    : ghJson(`repos/${REPO}/issues/${number}`, null);
  if (!thread) throw new Error(`could not fetch ${isPr ? 'PR' : 'issue'} #${number}`);
  const current = (thread.labels || []).map((l) => l.name);
  if (isThreadSettledHuman(current)) {
    console.log(
      `Thread #${number} already labelled ${HUMAN_IN_THE_LOOP_LABEL} (sticky); skipping reclassification.`
    );
    return;
  }
  const contributions = isPr
    ? gatherPrContributions(number, thread)
    : gatherIssueContributions(number, thread);
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
  applyLabels(number, isPr, current, decideLabels(verdicts));
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
