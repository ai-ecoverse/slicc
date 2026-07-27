#!/usr/bin/env node
/*
 * Flake ledger — orchestrator (I/O).
 *
 * Sweeps recent CI runs, pulls their `test-timing-*` artifacts, reconstructs
 * which tests only passed after a retry, and files or updates one GitHub issue
 * per flaky test. Pure logic lives in `lib.mjs` (unit-tested); this file only
 * shells out to `gh` and the filesystem.
 *
 * Env:
 *   SINCE_DAYS     look-back window in days                 (default 1)
 *   RUN_LIMIT      max CI runs to inspect                   (default 40)
 *   WORKFLOW       workflow file to sweep                   (default ci.yml)
 *   BRANCH         branch filter, empty for all             (default main)
 *   FLAKE_LABEL    issue label for dedup + filing           (default debt:flake)
 *   MAX_NEW_ISSUES cap on issues opened per sweep           (default 5)
 *   OUTPUT_PATH    ledger JSON path                         (default ./flake-ledger.json)
 *   FLAKE_DRY_RUN  set to skip all writes to GitHub
 *   GH_TOKEN       token for `gh` (provided by Actions)
 *
 * Never exits non-zero because a flake was found: a ledger that reddens builds
 * is just the retry removed.
 */
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  aggregateFlakes,
  FLAKE_LABEL,
  parseFingerprints,
  partitionFlakes,
  renderIssueBody,
  renderIssueTitle,
  renderRecurrenceComment,
} from './lib.mjs';

const SINCE_DAYS = Number(process.env.SINCE_DAYS) || 1;
const RUN_LIMIT = Number(process.env.RUN_LIMIT) || 40;
const WORKFLOW = process.env.WORKFLOW || 'ci.yml';
const BRANCH = process.env.BRANCH ?? 'main';
const LABEL = process.env.FLAKE_LABEL || FLAKE_LABEL;
const MAX_NEW_ISSUES = Number(process.env.MAX_NEW_ISSUES) || 5;
const OUTPUT_PATH = process.env.OUTPUT_PATH || 'flake-ledger.json';
const DRY_RUN = Boolean(process.env.FLAKE_DRY_RUN);
const WINDOW = `last ${SINCE_DAYS} day(s)`;

function gh(args, opts = {}) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
}

function ghJson(args, fallback) {
  try {
    return JSON.parse(gh(args).trim() || 'null') ?? fallback;
  } catch (err) {
    console.warn(`⚠️  gh ${args[0]} ${args[1] ?? ''} failed: ${String(err.message).split('\n')[0]}`);
    return fallback;
  }
}

function repoUrl() {
  const slug = process.env.GITHUB_REPOSITORY;
  return slug ? `https://github.com/${slug}` : null;
}

/** Completed CI runs inside the look-back window. */
function listRuns() {
  const args = [
    'run',
    'list',
    '--workflow',
    WORKFLOW,
    '--limit',
    String(RUN_LIMIT),
    '--json',
    'databaseId,createdAt,conclusion,status,headSha',
  ];
  if (BRANCH) args.push('--branch', BRANCH);
  const runs = ghJson(args, []);
  const cutoff = Date.now() - SINCE_DAYS * 24 * 60 * 60 * 1000;
  return runs.filter((r) => r.status === 'completed' && Date.parse(r.createdAt) >= cutoff);
}

/** Every JSON file inside a downloaded artifact tree. */
function readJsonFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      out.push(readFileSync(join(entry.parentPath ?? entry.path, entry.name), 'utf8'));
    } catch {
      // A truncated or unreadable artifact must not abort the sweep.
    }
  }
  return out;
}

/**
 * Download one run's test-timing artifacts and return their raw contents.
 * A run whose artifacts have expired or were never uploaded yields `[]`.
 */
function fetchRunArtifacts(runId) {
  const dir = mkdtempSync(join(tmpdir(), `flake-${runId}-`));
  try {
    gh(['run', 'download', String(runId), '--pattern', 'test-timing-*', '--dir', dir], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return readJsonFiles(dir);
  } catch {
    return [];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function collectInputs(runs) {
  const inputs = [];
  for (const run of runs) {
    const texts = fetchRunArtifacts(run.databaseId);
    for (const text of texts) inputs.push({ text, runId: run.databaseId });
  }
  return inputs;
}

function fetchFiledIssues() {
  const issues = ghJson(
    [
      'issue',
      'list',
      '--label',
      LABEL,
      '--state',
      'all',
      '--limit',
      '500',
      '--json',
      'number,body,state',
    ],
    []
  );
  return parseFingerprints(issues);
}

function fileNewIssue(flake) {
  const title = renderIssueTitle(flake);
  const body = renderIssueBody(flake, { window: WINDOW, repoUrl: repoUrl() });
  if (DRY_RUN) {
    console.log(`   [dry-run] would open: ${title}`);
    return;
  }
  try {
    const url = gh(['issue', 'create', '--title', title, '--body', body, '--label', LABEL]).trim();
    console.log(`   opened ${url}`);
  } catch (err) {
    console.warn(`   ⚠️  could not open an issue for ${flake.fingerprint}: ${err.message}`);
  }
}

function updateExistingIssue(flake) {
  if (DRY_RUN) {
    console.log(`   [dry-run] would comment on #${flake.issue}: ${flake.testName}`);
    return;
  }
  try {
    if (flake.issueState !== 'OPEN') gh(['issue', 'reopen', String(flake.issue)]);
    gh([
      'issue',
      'comment',
      String(flake.issue),
      '--body',
      renderRecurrenceComment(flake, { window: `in the ${WINDOW}` }),
    ]);
    console.log(`   updated #${flake.issue}`);
  } catch (err) {
    console.warn(`   ⚠️  could not update #${flake.issue}: ${err.message}`);
  }
}

function setOutput(key, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

function main() {
  console.log(`🔎 Sweeping ${WORKFLOW} runs from the ${WINDOW}${BRANCH ? ` on ${BRANCH}` : ''}…`);
  const runs = listRuns();
  console.log(`   ${runs.length} completed run(s) in window.`);

  const inputs = collectInputs(runs);
  console.log(`   ${inputs.length} test-timing artifact file(s) downloaded.`);

  const flakes = aggregateFlakes(inputs);
  writeFileSync(
    OUTPUT_PATH,
    JSON.stringify({ window: WINDOW, runs: runs.length, flakes }, null, 2)
  );
  setOutput('count', String(flakes.length));
  setOutput('has_flakes', flakes.length > 0 ? 'true' : 'false');

  if (flakes.length === 0) {
    console.log('✅ No test passed only on retry. Nothing to record.');
    return;
  }

  console.log(`\n⚠️  ${flakes.length} flaky test(s) → ${OUTPUT_PATH}:`);
  for (const f of flakes) {
    console.log(`   • [${f.project}] ${f.testName} — ${f.occurrences} retried run(s)`);
  }

  const { fresh, recurring } = partitionFlakes(flakes, fetchFiledIssues());
  console.log(`\n${fresh.length} new, ${recurring.length} already filed.`);
  for (const flake of fresh.slice(0, MAX_NEW_ISSUES)) fileNewIssue(flake);
  if (fresh.length > MAX_NEW_ISSUES) {
    console.log(`   (${fresh.length - MAX_NEW_ISSUES} more deferred to the next sweep)`);
  }
  for (const flake of recurring) updateExistingIssue(flake);
}

main();
