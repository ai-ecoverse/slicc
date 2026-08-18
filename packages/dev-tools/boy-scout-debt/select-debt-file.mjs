#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
/*
 * Boy Scout Debt Dispatcher — CLI (I/O).
 *
 * Enumerates the six boy-scout debt lists, resolves each entry to a concrete
 * tracked file, drops files already claimed by an open pull request, picks the
 * smallest lowest-risk remaining candidate, and writes the choice plus the
 * composed fixer brief to `$GITHUB_OUTPUT`. Pure logic lives in `lib.mjs`
 * (unit-tested); this file only does I/O. Mirrors
 * `packages/dev-tools/codebase-sins/select-sin.mjs`.
 *
 * Outputs: `has_candidate`, `file`, `categories`, `slug`, `prompt`.
 * Exit codes: 0 on a pick AND on a clean no-op; non-zero only on missing env
 * or an unexpected GitHub API failure.
 *
 * Env:
 *   REPO                 owner/repo (required)
 *   GH_TOKEN             token for the pulls REST reads (required unless SKIP_CLAIMED=1)
 *   FILE_OVERRIDE        optional workflow_dispatch override: an exact repo-relative path
 *   SKIP_CLAIMED         set to 1 to skip the open-PR dedup reads (offline dry run)
 *   GITHUB_OUTPUT        Actions output file (when present)
 *   GITHUB_STEP_SUMMARY  Actions job-summary file (when present)
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { BASELINE_PATH as LAYER_BASELINE_PATH } from '../tools/check-layer-back-edges.mjs';
import { BASELINE_PATH as RECORD_BASELINE_PATH } from '../tools/check-record-string-unknown.mjs';
import { readBiomeConfig, repoRoot } from '../tools/size-exemption-lib.mjs';
import { buildCandidates, buildDebtMap, buildPrompt, selectDebtFile } from './lib.mjs';

const SCRIPT = 'boy-scout-debt';
/** Bound the REST work so a busy repo cannot make the selector run long. */
const MAX_OPEN_PRS = 50;
const MAX_FILE_PAGES_PER_PR = 3;

/** Append `key=value` to $GITHUB_OUTPUT, using the heredoc form for multi-line values. */
function setOutput(key, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  if (value.includes('\n')) {
    const delim = `EOF_${randomUUID().replace(/-/g, '')}`;
    appendFileSync(file, `${key}<<${delim}\n${value}\n${delim}\n`);
  } else {
    appendFileSync(file, `${key}=${value}\n`);
  }
}

function appendSummary(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  appendFileSync(file, `${markdown}\n`);
}

/** Every tracked repo-relative path, as a Set. */
function trackedFiles() {
  const r = spawnSync('git', ['ls-files', '-z'], {
    cwd: repoRoot,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error((r.stderr || 'git ls-files failed').trim());
  return new Set(r.stdout.split('\0').filter((s) => s.length > 0));
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // A missing or broken baseline degrades to "no debt list for that ratchet"
    // rather than aborting the run over the other five lists.
    return null;
  }
}

/** Byte size for each debt file, skipping any that vanished between git and stat. */
function sizesFor(files) {
  const out = new Map();
  for (const file of files) {
    try {
      out.set(file, statSync(resolve(repoRoot, file)).size);
    } catch {
      // Leave it unsized; buildCandidates sorts unknown sizes last.
    }
  }
  return out;
}

async function ghJson(repo, path) {
  const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${process.env.GH_TOKEN}`,
      'user-agent': SCRIPT,
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} ${res.statusText} for ${path}`);
  }
  return res.json();
}

/**
 * Files touched by currently-open pull requests. This IS the cross-run dedup:
 * a still-open PR from a previous dispatch takes its file out of the pool
 * without blocking the routine.
 */
async function claimedFiles(repo) {
  const prs = await ghJson(repo, '/pulls?state=open&per_page=100');
  const claimed = new Set();
  for (const pr of prs.slice(0, MAX_OPEN_PRS)) {
    for (let page = 1; page <= MAX_FILE_PAGES_PER_PR; page++) {
      const files = await ghJson(repo, `/pulls/${pr.number}/files?per_page=100&page=${page}`);
      for (const f of files) if (f?.filename) claimed.add(f.filename);
      if (files.length < 100) break;
    }
  }
  return claimed;
}

function loadCandidates() {
  const repoFiles = trackedFiles();
  const debtMap = buildDebtMap({
    biomeConfig: readBiomeConfig(),
    layerBaseline: readJson(LAYER_BASELINE_PATH),
    recordBaseline: readJson(RECORD_BASELINE_PATH),
    repoFiles,
  });
  return buildCandidates({ debtMap, fileSizes: sizesFor(debtMap.keys()) });
}

function reportCandidates(candidates, claimed) {
  console.log(`${SCRIPT}: ${candidates.length} tractable debt candidate(s)`);
  const rows = candidates.slice(0, 10);
  for (const c of rows) {
    const flag = claimed.has(c.file) ? ' [claimed]' : '';
    const kb = Number.isFinite(c.bytes) ? `${(c.bytes / 1024).toFixed(1)} KiB` : 'unknown size';
    console.log(`  - ${c.file} (${kb}; ${c.categories.join(', ')})${flag}`);
  }
  if (candidates.length > rows.length) {
    console.log(`  … and ${candidates.length - rows.length} more`);
  }
}

function writeSummary(candidates, selection) {
  const lines = ['## Boy Scout debt dispatcher', ''];
  if (selection.candidate) {
    lines.push(`Selected **\`${selection.candidate.file}\`**`);
    lines.push('', `Debt lists: ${selection.candidate.categories.join(', ')}`);
  } else {
    lines.push(`No dispatch: ${selection.reason}`);
  }
  lines.push('', `| File | KiB | Debt lists |`, '| --- | --- | --- |');
  for (const c of candidates.slice(0, 10)) {
    const kb = Number.isFinite(c.bytes) ? (c.bytes / 1024).toFixed(1) : '?';
    lines.push(`| \`${c.file}\` | ${kb} | ${c.categories.join(', ')} |`);
  }
  appendSummary(lines.join('\n'));
}

async function main() {
  const repo = process.env.REPO;
  const skipClaimed = process.env.SKIP_CLAIMED === '1';
  if (!repo && !skipClaimed) {
    console.error(`${SCRIPT}: REPO (owner/repo) is required`);
    return 2;
  }
  if (!process.env.GH_TOKEN && !skipClaimed) {
    console.error(`${SCRIPT}: GH_TOKEN is required (or set SKIP_CLAIMED=1 for an offline run)`);
    return 2;
  }

  const candidates = loadCandidates();
  let claimed = new Set();
  if (skipClaimed) {
    console.log(`${SCRIPT}: SKIP_CLAIMED=1 — not reading open PRs; dedup is disabled`);
  } else {
    claimed = await claimedFiles(repo);
    console.log(`${SCRIPT}: ${claimed.size} file(s) claimed by open pull requests`);
  }
  reportCandidates(candidates, claimed);

  const selection = selectDebtFile({
    candidates,
    claimedFiles: claimed,
    override: process.env.FILE_OVERRIDE,
  });
  writeSummary(candidates, selection);

  if (!selection.candidate) {
    setOutput('has_candidate', 'false');
    console.log(`${SCRIPT}: no dispatch — ${selection.reason}`);
    return 0;
  }

  const { candidate } = selection;
  setOutput('has_candidate', 'true');
  setOutput('file', candidate.file);
  setOutput('categories', candidate.categories.join(','));
  setOutput('slug', candidate.slug);
  setOutput('prompt', buildPrompt(candidate));

  const how = selection.overridden ? 'override' : `score ${candidate.score.toFixed(1)}`;
  console.log(`${SCRIPT}: dispatching ${candidate.file} (${how})`);
  console.log(`  debt lists: ${candidate.categories.join(', ')}`);
  console.log(`  branch: automation/boy-scout/${candidate.slug}`);
  if (selection.claimedSkipped > 0) {
    console.log(`  skipped ${selection.claimedSkipped} candidate(s) claimed by open PRs`);
  }
  return 0;
}

try {
  process.exit(await main());
} catch (err) {
  console.error(`${SCRIPT}: ${err instanceof Error ? err.message : String(err)}`);
  console.error(
    `${SCRIPT}: hint — the open-PR dedup needs a valid GH_TOKEN with pull-requests:read; ` +
      'run with SKIP_CLAIMED=1 to exercise the debt enumeration offline.'
  );
  process.exit(1);
}
