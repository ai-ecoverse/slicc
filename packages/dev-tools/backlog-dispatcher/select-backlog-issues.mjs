#!/usr/bin/env node
/*
 * Backlog Dispatcher — selector (I/O).
 *
 * Lists the repository's open issues and open pull requests, screens and ranks
 * them with `lib.mjs` (pure, unit-tested), writes the survivors to
 * `backlog-candidates.json` for the triage phase to read (mirroring
 * `rum-error-candidates.json` in rum-error-triage.yml), and emits the triage
 * prompt plus the dispatch budget to `$GITHUB_OUTPUT`.
 *
 * This selector performs NO writes against GitHub: no labels, no comments, no
 * PRs. Labelling is the triage phase's job; the only deterministic writer in
 * this package is `sweep-stale-prs.mjs`.
 *
 * The repository is read from the environment, never hardcoded, so this package
 * can be promoted to a reusable `ai-ecoverse/.github` workflow unchanged.
 *
 * Env:
 *   REPO               owner/repo (falls back to GITHUB_REPOSITORY)   (required)
 *   GH_TOKEN           token for the GitHub REST reads                (required unless FIXTURE)
 *   ISSUE_NUMBER       consider ONLY this issue (workflow_dispatch). Waives the
 *                      settling-age wait and nothing else.
 *   DRY_RUN            "true" → report only; still performs no write anyway
 *   MAX_DISPATCHES     optional lower override of CONFIG.MAX_DISPATCHES_PER_RUN
 *   SKIP_PR_CHECK      "1" → do not read open PRs (skips the in-flight/budget reads)
 *   BACKLOG_FIXTURE    path to `{ "issues": [...], "prs": [...] }` — runs the
 *                      whole selector offline against canned API payloads
 *   OUTPUT_PATH        candidates JSON path (default ./backlog-candidates.json)
 *
 * Outputs: `has_candidates`, `candidate_count`, `dispatch_budget`, `prompt`.
 * Exit codes: 0 on a pick AND on a clean no-op; non-zero only on missing env or
 * an unexpected GitHub API failure.
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import {
  buildDigest,
  buildTriagePrompt,
  CONFIG,
  dispatchBudget,
  isDispatcherPr,
  selectCandidates,
  selectStalePrs,
} from './lib.mjs';

const SCRIPT = 'backlog-dispatcher';
const API = 'https://api.github.com';
const OUTPUT_PATH = process.env.OUTPUT_PATH || 'backlog-candidates.json';
const DRY_RUN = (process.env.DRY_RUN ?? '').trim() === 'true';
const SKIP_PR_CHECK = (process.env.SKIP_PR_CHECK ?? '').trim() === '1';
const FIXTURE = (process.env.BACKLOG_FIXTURE ?? '').trim();
/** Pages of 100 read per list endpoint. Bounded so a huge backlog cannot make the run long. */
const MAX_PAGES = 5;

// ── Actions plumbing ─────────────────────────────────────────────────────────

/** Append `key=value` to $GITHUB_OUTPUT, using the heredoc form for multi-line values. */
function setOutput(key, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const text = String(value);
  if (text.includes('\n')) {
    const delim = `EOF_${randomUUID().replace(/-/g, '')}`;
    appendFileSync(file, `${key}<<${delim}\n${text}\n${delim}\n`);
  } else {
    appendFileSync(file, `${key}=${text}\n`);
  }
}

function appendSummary(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  appendFileSync(file, `${markdown}\n`);
}

// ── REST layer (same shape as pr-fix-dispatcher/scan-failing-prs.mjs) ────────

/** Low-level GitHub REST call. Throws a one-line error on an untolerated non-OK response. */
async function request(method, path, { tolerate = [] } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${process.env.GH_TOKEN}`,
      'user-agent': SCRIPT,
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!res.ok && !tolerate.includes(res.status)) {
    const text = await res.text().catch(() => '');
    // Collapse onto one line: GitHub's error JSON is multi-line and the
    // top-level handler prints only the first line of the message.
    throw new Error(
      `${method} ${path} → ${res.status} ${res.statusText} ${text.replace(/\s+/g, ' ').trim().slice(0, 200)}`
    );
  }
  return res;
}

/**
 * Read returning parsed JSON, or `null`. An empty body also yields `null`:
 * `res.json()` throws "Unexpected end of JSON input" on one, and GitHub
 * legitimately answers some calls with no body at all.
 */
async function ghGet(path, opts = {}) {
  const res = await request('GET', path, opts);
  if (!res.ok) return null;
  const text = await res.text();
  return text.trim() === '' ? null : JSON.parse(text);
}

/** GET every page of a list endpoint (per_page=100), stopping at MAX_PAGES. */
async function ghGetAll(path) {
  const joiner = path.includes('?') ? '&' : '?';
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const batch = await ghGet(`${path}${joiner}per_page=100&page=${page}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

// ── Sources ──────────────────────────────────────────────────────────────────

/** `{ issues, prs }` from a fixture file — the fully offline path. */
function readFixture(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  return { issues: parsed.issues ?? [], prs: parsed.prs ?? [] };
}

/**
 * Open issues to consider. `GET /issues` also returns pull requests; the lib
 * screens those out by their `pull_request` field rather than trusting a query
 * parameter GitHub does not offer.
 */
async function readIssues(repo, single) {
  if (single) {
    const issue = await ghGet(`/repos/${repo}/issues/${single}`);
    return issue ? [issue] : [];
  }
  return ghGetAll(`/repos/${repo}/issues?state=open&sort=created&direction=desc`);
}

async function readOpenPrs(repo) {
  if (SKIP_PR_CHECK) {
    console.log(`${SCRIPT}: SKIP_PR_CHECK=1 — not reading open PRs; in-flight dedup is disabled`);
    return [];
  }
  return ghGetAll(`/repos/${repo}/pulls?state=open&sort=updated&direction=desc`);
}

// ── Reporting ────────────────────────────────────────────────────────────────

function reportCandidates(selection) {
  console.log(`${SCRIPT}: ${selection.candidates.length} candidate issue(s) after screening`);
  for (const c of selection.candidates.slice(0, 10)) {
    const smells = c.smells.length ? ` [smells: ${c.smells.join(', ')}]` : '';
    console.log(`  - #${c.number} (${c.class}, score ${c.score}) ${c.title}${smells}`);
  }
  if (selection.truncated > 0) {
    console.log(
      `  … ${selection.truncated} more over the cap of ${CONFIG.MAX_CANDIDATES_PER_SOURCE}`
    );
  }
}

/** The candidate payload phase 1 reads. Bodies are kept — Claude needs the brief. */
function writeCandidatesFile(candidates) {
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(candidates, null, 2)}\n`);
  console.log(`${SCRIPT}: wrote ${candidates.length} candidate(s) to ${OUTPUT_PATH}`);
}

function resolveRepo() {
  const repo = (process.env.REPO || process.env.GITHUB_REPOSITORY || '').trim();
  if (repo || FIXTURE) return repo;
  console.error(`${SCRIPT}: REPO (or GITHUB_REPOSITORY) is required, e.g. owner/repo`);
  return null;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function loadSources(repo, single) {
  if (FIXTURE) {
    console.log(`${SCRIPT}: BACKLOG_FIXTURE=${FIXTURE} — offline run, no GitHub API calls`);
    return readFixture(FIXTURE);
  }
  const [issues, prs] = await Promise.all([readIssues(repo, single), readOpenPrs(repo)]);
  return { issues, prs };
}

async function main() {
  const repo = resolveRepo();
  if (repo === null) return 2;
  if (!process.env.GH_TOKEN && !FIXTURE) {
    console.error(
      `${SCRIPT}: GH_TOKEN is required (or set BACKLOG_FIXTURE=<path> for an offline run)`
    );
    return 2;
  }

  const now = new Date();
  const single = (process.env.ISSUE_NUMBER ?? '').trim();
  if (single) console.log(`${SCRIPT}: targeted run for ${repo}#${single} (settling wait waived)`);

  const { issues, prs } = await loadSources(repo, single);
  const openDispatcherPrs = prs.filter((pr) => isDispatcherPr(pr)).length;
  const maxPerRun = Number(process.env.MAX_DISPATCHES) || CONFIG.MAX_DISPATCHES_PER_RUN;
  const budget = dispatchBudget({ openDispatcherPrs, maxPerRun });

  const selection = selectCandidates(issues, {
    now,
    openPrs: prs,
    targeted: Boolean(single),
  });
  reportCandidates(selection);
  writeCandidatesFile(selection.candidates);

  const stale = selectStalePrs(prs, { now });
  appendSummary(
    buildDigest({
      repo,
      candidates: selection.candidates,
      rejected: selection.rejected,
      budget,
      openDispatcherPrs,
      stale,
      truncated: selection.truncated,
      dryRun: DRY_RUN,
    })
  );

  const hasCandidates = selection.candidates.length > 0 && budget > 0;
  setOutput('has_candidates', hasCandidates ? 'true' : 'false');
  setOutput('candidate_count', String(selection.candidates.length));
  setOutput('dispatch_budget', String(budget));
  setOutput(
    'prompt',
    buildTriagePrompt(selection.candidates, {
      repo,
      budget,
      runUrl: process.env.RUN_URL ?? '',
    })
  );

  if (budget === 0) {
    console.log(
      `${SCRIPT}: no dispatch — ${openDispatcherPrs} dispatcher PR(s) already open (ceiling ${CONFIG.MAX_OPEN_PRS})`
    );
  } else if (!hasCandidates) {
    console.log(`${SCRIPT}: no dispatch — nothing survived screening; an empty tick is a success`);
  } else {
    console.log(`${SCRIPT}: budget ${budget} dispatch(es) this tick`);
  }
  return 0;
}

try {
  process.exit(await main());
} catch (err) {
  console.error(
    `${SCRIPT}: ${err instanceof Error ? (err.message.split('\n')[0] ?? '') : String(err)}`
  );
  console.error(
    `${SCRIPT}: hint — the reads need a GH_TOKEN with issues:read + pull-requests:read; ` +
      'set BACKLOG_FIXTURE=<path> to exercise the screening logic offline.'
  );
  process.exit(1);
}
