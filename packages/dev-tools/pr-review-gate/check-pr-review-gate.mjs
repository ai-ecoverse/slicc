#!/usr/bin/env node
/*
 * PR-review gate — orchestrator (I/O).
 *
 * Reads a PR's state and its inline review comments from the GitHub REST API,
 * then asks `decideReview` (pure, unit-tested in `lib.mjs`) whether the
 * automated Claude review should run. Writes `should_review` and `reason` to
 * $GITHUB_OUTPUT for the workflow to gate on. This file only does I/O.
 *
 * Env:
 *   REPO        owner/repo                          (required)
 *   PR_NUMBER   pull request number                 (required)
 *   GH_TOKEN    token for the GitHub API            (required)
 *
 * Exit 0 on a clean decision (review or skip); non-zero only on missing env
 * or an unexpected API/network failure.
 */
import { appendFileSync } from 'node:fs';
import { countInlineReviewComments, decideReview } from './lib.mjs';

const API = 'https://api.github.com';

function requireEnv(name) {
  const value = (process.env[name] ?? '').trim();
  if (!value) {
    console.error(`❌ Missing required env var ${name}.`);
    process.exit(2);
  }
  return value;
}

/** GitHub REST GET returning parsed JSON. Throws on a non-OK response. */
async function ghGet(path, token) {
  const res = await fetch(`${API}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'slicc-pr-review-gate',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GET ${path} → ${res.status} ${res.statusText} ${body.slice(0, 200)}`);
  }
  return res.json();
}

/** Fetch every inline review comment, following pagination (per_page=100). */
async function fetchInlineComments(repo, prNumber, token) {
  const all = [];
  for (let page = 1; ; page += 1) {
    const batch = await ghGet(
      `/repos/${repo}/pulls/${prNumber}/comments?per_page=100&page=${page}`,
      token
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

function setOutput(key, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

async function main() {
  const repo = requireEnv('REPO');
  const prNumber = requireEnv('PR_NUMBER');
  const token = requireEnv('GH_TOKEN');
  const forceReview = (process.env.FORCE_REVIEW ?? '').trim() === 'true';

  if (forceReview) {
    const reason = 'Manual dispatch — skipping gate, forcing review.';
    setOutput('should_review', 'true');
    setOutput('reason', reason);
    console.log(reason);
    return;
  }

  const pr = await ghGet(`/repos/${repo}/pulls/${prNumber}`, token);
  const comments = await fetchInlineComments(repo, prNumber, token);

  const decision = decideReview({
    state: pr.state,
    isDraft: Boolean(pr.draft),
    inlineReviewCommentCount: countInlineReviewComments(comments),
  });

  setOutput('should_review', decision.shouldReview ? 'true' : 'false');
  setOutput('reason', decision.reason);
  console.log(decision.reason);
}

main().catch((err) => {
  console.error(`❌ PR-review gate failed: ${err.message?.split('\n')[0] ?? err}`);
  process.exit(1);
});
