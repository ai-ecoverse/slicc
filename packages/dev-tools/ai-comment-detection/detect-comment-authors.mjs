#!/usr/bin/env node

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
const MIN_PANGRAM_CHARS = 50;
const POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 30;
const PANGRAM_POST_ATTEMPTS = 3;
const PANGRAM_RETRY_BASE_MS = 1000;
const PANGRAM_REQUEST_TIMEOUT_MS = 10000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readEvent() {
  const path = process.env.GITHUB_EVENT_PATH;
  if (!path) throw new Error('GITHUB_EVENT_PATH is not set');
  return JSON.parse(readFileSync(path, 'utf8'));
}

function resolveTarget(event) {
  if (event.pull_request?.number) return { number: event.pull_request.number, isPr: true };
  if (event.issue?.number) {
    return { number: event.issue.number, isPr: Boolean(event.issue.pull_request) };
  }
  return null;
}

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

function ghList(endpoint) {
  const out = execFileSync('gh', ['api', '--paginate', '--slurp', endpoint], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const pages = JSON.parse(out.trim() || '[]');
  return Array.isArray(pages) ? pages.flat() : [];
}

function toContribution(obj) {
  return {
    login: obj.user?.login,
    type: obj.user?.type,
    body: obj.body ?? '',
    viaApp: Boolean(obj.performed_via_github_app),
  };
}

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

function gatherIssueContributions(number, issue) {
  const comments = ghList(`repos/${REPO}/issues/${number}/comments?per_page=100`);
  return [toContribution(issue), ...comments.map(toContribution)].filter(
    (c) => (c.body ?? '').trim() || c.login
  );
}

async function createPangramTask(headers, payload) {
  for (let attempt = 1; attempt <= PANGRAM_POST_ATTEMPTS; attempt += 1) {
    try {
      const created = await fetch(`${PANGRAM_BASE}/task`, {
        method: 'POST',
        headers,
        body: payload,
        signal: AbortSignal.timeout(PANGRAM_REQUEST_TIMEOUT_MS),
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

async function pangramDetect(text) {
  if (!PANGRAM_KEY || (text ?? '').trim().length < MIN_PANGRAM_CHARS) return null;
  const headers = { 'Content-Type': 'application/json', 'x-api-key': PANGRAM_KEY };
  const payload = JSON.stringify({ text, public_dashboard_link: false });
  const taskId = await createPangramTask(headers, payload);
  if (!taskId) return null;
  for (let i = 0; i < MAX_POLLS; i += 1) {
    await sleep(POLL_INTERVAL_MS);
    try {
      const res = await fetch(`${PANGRAM_BASE}/task/${taskId}`, {
        headers,
        signal: AbortSignal.timeout(PANGRAM_REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        const retryable = isRetryablePangramStatus(res.status);
        console.warn(
          `⚠️  Pangram GET /task/${taskId} → HTTP ${res.status}` +
            (retryable ? '; retrying poll.' : ' (terminal; not retrying).')
        );
        if (!retryable) return null;
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
    const detail = v.reason ? ` (${v.reason})` : '';
    console.log(
      `   ${v.isHuman ? '🧑 human' : '🤖 ai/bot'} via ${v.method}${detail} — @${contributions[i].login}`
    );
  }
  applyLabels(number, isPr, current, decideLabels(verdicts));
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
