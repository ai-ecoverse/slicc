#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
/*
 * Weekend CLAUDE.md Compactor — CLI (I/O).
 *
 * Enumerates every TRACKED file named `CLAUDE.md` via `git ls-files` (so
 * untracked and generated files can never be picked up), measures each one in
 * characters, and reports which are oversized under the compactor policy
 * (>= MAX_CHARS, default 10,000 — a stricter, wider policy than the repo's own
 * 20,000-char `packages/*` gate; see `lib.mjs` for the distinction).
 *
 * Two modes:
 *   (default)  Measure + query open PRs for the cross-run dedup rule, then
 *              write `has_oversized`, `oversized_count`, `branch`,
 *              `existing_pr`, `report`, and `prompt` to $GITHUB_OUTPUT and the
 *              table to $GITHUB_STEP_SUMMARY. Always exits 0 when measurement
 *              succeeds, including the clean no-op.
 *   --check    Measure only and FAIL (exit 1) if any tracked guide is still at
 *              or above MAX_CHARS. This is the post-compaction invariant, run
 *              deterministically by the workflow instead of trusted to the
 *              model. No GitHub API access, no outputs beyond the summary.
 *
 * Pure logic (thresholds, selection, report, branch name, dedup rule, prompt)
 * lives in `lib.mjs` and is unit-tested. This file only does I/O. Mirrors
 * `packages/dev-tools/codebase-sins/select-sin.mjs`.
 *
 * Env:
 *   REPO           owner/repo — required unless --check or SKIP_PR_CHECK=1
 *   GH_TOKEN       token for the GitHub API — same condition as REPO
 *   MAX_CHARS      override the 10,000-char oversized threshold  (optional)
 *   TARGET_CHARS   override the 9,500-char compaction target     (optional)
 *   SKIP_PR_CHECK  '1' to skip the open-PR dedup query (offline runs)
 *   GITHUB_OUTPUT / GITHUB_STEP_SUMMARY  Actions files, written when present
 *
 * Exit 0 on a clean run (work found or not); 1 on a --check violation or an
 * unexpected API failure; 2 on missing required env.
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildBranchName,
  buildPrompt,
  COMPACTOR_MAX_CHARS,
  COMPACTOR_TARGET_CHARS,
  findExistingCompactionPr,
  formatReport,
  measureGuides,
  selectOversized,
} from './lib.mjs';

const API = 'https://api.github.com';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function requireEnv(name) {
  const value = (process.env[name] ?? '').trim();
  if (!value) {
    console.error(`❌ Missing required env var ${name}.`);
    process.exit(2);
  }
  return value;
}

/** Positive integer env override, falling back to `fallback` when unset/invalid. */
function intEnv(name, fallback) {
  const raw = (process.env[name] ?? '').trim();
  if (!/^[0-9]+$/.test(raw)) return fallback;
  const n = Number(raw);
  return n > 0 ? n : fallback;
}

/** Every tracked file whose basename is CLAUDE.md, repo-relative, sorted. */
function listTrackedGuides() {
  const out = execFileSync('git', ['ls-files', '-z', '--', '*CLAUDE.md'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return out
    .split('\0')
    .filter((p) => p !== '' && basename(p) === 'CLAUDE.md')
    .sort();
}

/** Read each guide and measure it. Characters via `.length`, never bytes. */
function readGuides(paths) {
  return paths.map((path) => ({ path, content: readFileSync(resolve(repoRoot, path), 'utf8') }));
}

/** Open PRs against the default branch, one page (100) — dedup only needs recency. */
async function fetchOpenPrs(repo, token) {
  const res = await fetch(`${API}/repos/${repo}/pulls?state=open&per_page=100`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'slicc-claude-md-compactor',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `GET /repos/${repo}/pulls → ${res.status} ${res.statusText} ${body.slice(0, 200)}`
    );
  }
  return res.json();
}

/** Append `key=value` to $GITHUB_OUTPUT, using the heredoc form for multi-line values. */
function setOutput(key, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const str = String(value);
  if (str.includes('\n')) {
    const delim = `EOF_${randomUUID().replace(/-/g, '')}`;
    appendFileSync(file, `${key}<<${delim}\n${str}\n${delim}\n`);
  } else {
    appendFileSync(file, `${key}=${str}\n`);
  }
}

function writeSummary(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, `${markdown}\n`);
}

function logMeasurements(measurements, maxChars) {
  for (const m of measurements) {
    const mark = m.excluded ? '·' : m.oversized ? '⚠️' : 'ok';
    console.log(`${mark} ${m.chars}/${maxChars} ${m.path}`);
  }
}

async function main() {
  const check = process.argv.includes('--check');
  const maxChars = intEnv('MAX_CHARS', COMPACTOR_MAX_CHARS);
  const targetChars = intEnv('TARGET_CHARS', COMPACTOR_TARGET_CHARS);

  const guides = readGuides(listTrackedGuides());
  const measurements = measureGuides(guides, { maxChars });
  const oversized = selectOversized(measurements);
  const report = formatReport(measurements, { maxChars });

  logMeasurements(measurements, maxChars);

  if (check) {
    writeSummary(`## CLAUDE.md size check\n\n${report}`);
    if (oversized.length > 0) {
      for (const m of oversized) {
        console.error(
          `::error file=${m.path}::${m.path} is ${m.chars} chars, policy limit ${maxChars}.`
        );
      }
      console.error(`❌ ${oversized.length} guide(s) still at or above ${maxChars} chars.`);
      process.exit(1);
    }
    console.log(`✅ All ${measurements.length} tracked guides are below ${maxChars} chars.`);
    return;
  }

  const branch = buildBranchName(new Date());
  let existing = null;
  if (oversized.length > 0 && (process.env.SKIP_PR_CHECK ?? '').trim() !== '1') {
    const repo = requireEnv('REPO');
    const token = requireEnv('GH_TOKEN');
    existing = findExistingCompactionPr(await fetchOpenPrs(repo, token));
  }

  setOutput('has_oversized', oversized.length > 0 ? 'true' : 'false');
  setOutput('oversized_count', String(oversized.length));
  setOutput('branch', branch);
  setOutput('existing_pr', existing?.url ?? '');
  setOutput('report', report);
  setOutput(
    'prompt',
    oversized.length > 0 ? buildPrompt({ oversized, maxChars, targetChars, branch, report }) : ''
  );

  writeSummary(`## Weekend CLAUDE.md compaction\n\n${report}`);

  if (oversized.length === 0) {
    console.log('✅ Nothing oversized — clean no-op, no branch and no PR.');
    return;
  }
  if (existing) {
    console.log(`⏭️  A compaction PR is already open: ${existing.url} — skipping this run.`);
    return;
  }
  console.log(`🧹 ${oversized.length} guide(s) to compact on branch ${branch}.`);
}

main().catch((err) => {
  console.error(`❌ CLAUDE.md compactor measurement failed: ${err.message?.split('\n')[0] ?? err}`);
  process.exit(1);
});
