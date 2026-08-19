#!/usr/bin/env node
/*
 * Review Responder — orchestrator (I/O).
 *
 * Reads one PR's state and ALL THREE of its feedback endpoints, folds them with
 * the pure helpers in `lib.mjs`, and writes the decision to `$GITHUB_OUTPUT` for
 * `.github/workflows/review-responder.yml` to gate its Claude step on.
 *
 * This tool performs no writes of any kind — not even in a non-dry run. The
 * marker comment is posted by a separate deterministic workflow step after
 * Claude finishes, because posting it here would record a response that had not
 * happened yet if the Claude step then failed.
 *
 * The three endpoints are not interchangeable, and using fewer is the bug that
 * makes this feature look like it works while ignoring the reviewer that
 * matters most:
 *   /pulls/{n}/reviews   review summaries + APPROVED/CHANGES_REQUESTED state
 *                        (Codex and Copilot submit real reviews)
 *   /pulls/{n}/comments  inline review comments, with path + line
 *   /issues/{n}/comments top-level comments — where this repo's own
 *                        `claude-pr-review.yml` posts its verdict, and also
 *                        where our response markers live
 *
 * Env:
 *   REPO        owner/repo                                       (required)
 *   PR_NUMBER   pull request number                              (required)
 *   GH_TOKEN    token for the GitHub REST API                    (required)
 *   SELF_LOGIN  login whose comments are our own output          (default github-actions[bot])
 *   DRY_RUN     "true" → print the decision, force should_respond=false
 *
 * Outputs (to $GITHUB_OUTPUT): `should_respond`, `reason`, `feedback_file`,
 * `feedback_count`, `head_sha`, `head_ref`, `pr_title`.
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_SELF_LOGIN,
  decideResponse,
  formatDrops,
  formatFeedbackDigest,
  lastResponseAt,
  parseRespondedShas,
  partitionFeedback,
} from './lib.mjs';

const API = 'https://api.github.com';

const DRY_RUN = (process.env.DRY_RUN ?? '').trim() === 'true';
const SELF_LOGIN = (process.env.SELF_LOGIN ?? '').trim() || DEFAULT_SELF_LOGIN;

function requireEnv(name) {
  const value = (process.env[name] ?? '').trim();
  if (!value) {
    console.error(`❌ Missing required env var ${name}.`);
    process.exit(2);
  }
  return value;
}

const REPO = requireEnv('REPO');
const PR_NUMBER = requireEnv('PR_NUMBER');
const TOKEN = requireEnv('GH_TOKEN');

/** GitHub REST GET returning parsed JSON. Throws a one-line error on non-OK. */
async function ghGet(path) {
  const res = await fetch(`${API}${path}`, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'slicc-review-responder',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // Collapsed to one line: the top-level handler prints only the first line
    // of the message, and GitHub's error JSON is multi-line.
    const detail = body.replace(/\s+/g, ' ').trim().slice(0, 200);
    throw new Error(`GET ${path} → ${res.status} ${res.statusText} ${detail}`);
  }
  return res.json();
}

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

function setOutput(key, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

/** Multi-line-safe $GITHUB_OUTPUT write (heredoc form). */
function setMultilineOutput(key, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  const delimiter = `EOF_${key}_${Math.random().toString(36).slice(2, 10)}`;
  appendFileSync(process.env.GITHUB_OUTPUT, `${key}<<${delimiter}\n${value}\n${delimiter}\n`);
}

function appendSummary(text) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}

/** One line, no `${{`, so it is safe in a workflow output and a YAML scalar. */
const oneLine = (text, max = 200) =>
  String(text ?? '')
    .replace(/\s+/g, ' ')
    .replaceAll('${{', '$ {{')
    .trim()
    .slice(0, max);

async function main() {
  const [pr, reviews, reviewComments, issueComments] = await Promise.all([
    ghGet(`/repos/${REPO}/pulls/${PR_NUMBER}`),
    ghGetAll(`/repos/${REPO}/pulls/${PR_NUMBER}/reviews`, 3),
    ghGetAll(`/repos/${REPO}/pulls/${PR_NUMBER}/comments`, 3),
    ghGetAll(`/repos/${REPO}/issues/${PR_NUMBER}/comments`, 3),
  ]);

  const headSha = String(pr.head?.sha ?? '');
  const { feedback, dropped } = partitionFeedback({
    reviews,
    reviewComments,
    issueComments,
    selfLogin: SELF_LOGIN,
  });
  const respondedShas = parseRespondedShas(issueComments);

  const decision = decideResponse({
    state: pr.state,
    isDraft: Boolean(pr.draft),
    headRefName: pr.head?.ref ?? '',
    headRepoFullName: pr.head?.repo?.full_name ?? null,
    repoFullName: REPO,
    feedback,
    lastRespondedSha: respondedShas.has(headSha.toLowerCase()) ? headSha : null,
    headSha,
    lastResponseAt: lastResponseAt(issueComments, SELF_LOGIN),
    selfLogin: SELF_LOGIN,
  });

  // Written unconditionally so a skip run still shows what it saw — the fastest
  // way to tell "no feedback" apart from "an endpoint is not wired up".
  const feedbackFile = join(
    process.env.RUNNER_TEMP || tmpdir(),
    `review-feedback-${PR_NUMBER}.json`
  );
  writeFileSync(
    feedbackFile,
    `${JSON.stringify(
      {
        repo: REPO,
        pr: Number(PR_NUMBER),
        title: pr.title ?? '',
        headRef: pr.head?.ref ?? '',
        headSha,
        selfLogin: SELF_LOGIN,
        reason: decision.reason,
        items: decision.items,
      },
      null,
      2
    )}\n`
  );

  console.log(`🔎 ${REPO}#${PR_NUMBER} — ${pr.title ?? '(no title)'}`);
  console.log(
    `   endpoints: ${reviews.length} review(s), ${reviewComments.length} inline comment(s), ${issueComments.length} top-level comment(s)`
  );
  // Printed even when it changes nothing: "0 feedback items" and "12 items, all
  // filtered" look identical in a decision line, and only one of them is a bug.
  if (dropped.length > 0) console.log(formatDrops(dropped));
  console.log(`   feedback left to answer: ${feedback.length}`);
  if (feedback.length > 0) console.log(formatFeedbackDigest(feedback));
  console.log(`   decision: ${decision.shouldRespond ? 'RESPOND' : 'skip'} — ${decision.reason}`);
  console.log(`   feedback file: ${feedbackFile}`);

  appendSummary('## Review Responder\n');
  appendSummary(
    `**${REPO}#${PR_NUMBER}** · ${decision.shouldRespond ? 'responding' : 'skipping'}${DRY_RUN ? ' · **DRY RUN**' : ''}\n`
  );
  appendSummary(`${decision.reason}\n`);
  if (decision.items.length > 0) {
    appendSummary('```');
    appendSummary(formatFeedbackDigest(decision.items));
    appendSummary('```');
  }

  // A dry run must be able to reach every read path above and still be
  // guaranteed not to start Claude, so the override lands on the output rather
  // than on an early return.
  setOutput('should_respond', decision.shouldRespond && !DRY_RUN ? 'true' : 'false');
  setMultilineOutput('reason', decision.reason);
  setOutput('feedback_file', feedbackFile);
  setOutput('feedback_count', String(decision.items.length));
  setOutput('head_sha', headSha);
  setOutput('head_ref', pr.head?.ref ?? '');
  setOutput('pr_title', oneLine(pr.title));
}

main().catch((err) => {
  console.error(`❌ Review Responder scan failed: ${err.message?.split('\n')[0] ?? err}`);
  process.exit(1);
});
