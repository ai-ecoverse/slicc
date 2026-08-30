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
 * Three modes:
 *   (default)  Measure + query open PRs for the cross-run dedup rule, then
 *              write `has_oversized`, `oversized_count`, `branch`,
 *              `existing_pr`, `before_sizes`, `report`, and `prompt` to
 *              $GITHUB_OUTPUT and the table to $GITHUB_STEP_SUMMARY. Always
 *              exits 0 when measurement succeeds, including the clean no-op.
 *   --check    Measure only and FAIL (exit 1) if any tracked guide is still at
 *              or above MAX_CHARS, or if any guide named in WORKLIST is above
 *              TARGET_CHARS. This is the post-compaction invariant, run
 *              deterministically by the workflow instead of trusted to the
 *              model. No GitHub API access, no outputs beyond the summary.
 *   --progress After a failed --check: compare the working tree to BEFORE_SIZES
 *              (the measure step's `before_sizes` output). Exit 0 and set
 *              `recovered=true` when at least one worklist guide strictly
 *              shrank and none grew — the workflow then opens a partial PR.
 *              Exit 1 when nothing got smaller (Saturday 2026-08-30: Claude
 *              ran, every selected guide was still at its pre-run size).
 *              Writes a PR body to $PR_BODY_FILE if Claude left it empty.
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
 *   MAX_GUIDES     how many oversized guides to hand Claude this run
 *                  (default 1 — one file, largest first). 0 = all.
 *   WORKLIST       --check/--progress: comma/newline-separated guide paths
 *                  that were handed to Claude, held to TARGET_CHARS instead of
 *                  MAX_CHARS. Emitted as the `worklist` output by the measuring
 *                  run, since a rewritten guide no longer looks oversized.
 *   BEFORE_SIZES   --progress: JSON object of path → pre-Claude char counts
 *                  (the measure step's `before_sizes` output).
 *   PR_BODY_FILE   --progress: write a synthesised partial-PR body here when
 *                  Claude left the file missing or empty.
 *   SHRUNK_PATHS_FILE --progress: newline-separated worklist paths that shrank,
 *                  so the workflow can `git add` leftover working-tree edits.
 *   SKIP_PR_CHECK  '1' to skip the open-PR dedup query (offline runs)
 *   GITHUB_OUTPUT / GITHUB_STEP_SUMMARY  Actions files, written when present
 *
 * Exit 0 on a clean run (work found or not); 1 on a --check violation, a
 * --progress with no recoverable shrinkage, or an unexpected API failure; 2
 * on missing required env.
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assessCompactionProgress,
  buildBranchName,
  buildPartialPrBody,
  buildPrompt,
  COMPACTION_PR_TITLE,
  COMPACTOR_MAX_CHARS,
  COMPACTOR_TARGET_CHARS,
  DEFAULT_MAX_GUIDES,
  findExistingCompactionPr,
  formatBeforeSizes,
  formatProgressReport,
  formatReport,
  measureGuides,
  parseBeforeSizes,
  parseWorklist,
  selectAboveTarget,
  selectOversized,
  selectWorklist,
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

function existingBody(file) {
  if (!file) return '';
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function runProgressCheck(measurements, { maxChars, targetChars }) {
  const worklist = parseWorklist(process.env.WORKLIST);
  const before = parseBeforeSizes(process.env.BEFORE_SIZES);
  const assessment = assessCompactionProgress({
    before,
    after: measurements,
    worklist,
    maxChars,
    targetChars,
  });
  const progress = formatProgressReport(assessment, { maxChars, targetChars });
  writeSummary(`## CLAUDE.md compaction progress\n\n${progress}`);
  console.log(progress);

  setOutput('recovered', assessment.recovered ? 'true' : 'false');
  setOutput('open_pr', assessment.openPr ? 'true' : 'false');

  const shrunkFile = (process.env.SHRUNK_PATHS_FILE ?? '').trim();
  if (shrunkFile) {
    const lines = assessment.shrunk.map((r) => r.path);
    writeFileSync(shrunkFile, lines.length > 0 ? `${lines.join('\n')}\n` : '');
  }

  if (assessment.recovered) {
    const bodyFile = (process.env.PR_BODY_FILE ?? '').trim();
    if (bodyFile && existingBody(bodyFile).trim() === '') {
      writeFileSync(bodyFile, buildPartialPrBody(assessment, { maxChars, targetChars }));
      console.log(`Wrote partial PR body to ${bodyFile}`);
    }
    console.log(
      `⚠️ Policy target missed, but ${assessment.shrunk.length} selected guide(s) got smaller — recovering with a partial PR.`
    );
    return;
  }

  if (assessment.policyOk) {
    console.log('✅ Policy already met — nothing to recover.');
    return;
  }

  if (assessment.grew.length > 0) {
    for (const r of assessment.grew) {
      console.error(
        `::error file=${r.path}::${r.path} grew from ${r.beforeChars} to ${r.afterChars} chars.`
      );
    }
  }
  if (assessment.newOversized.length > 0) {
    for (const m of assessment.newOversized) {
      console.error(
        `::error file=${m.path}::${m.path} is ${m.chars} chars and was not on the worklist — a new oversized guide.`
      );
    }
  }
  if (assessment.shrunk.length === 0) {
    console.error('❌ No selected guide got smaller.');
  }
  console.error(
    '❌ No recoverable progress: selected guides did not get smaller (or some grew / a new guide became oversized).'
  );
  process.exit(1);
}

async function main() {
  const check = process.argv.includes('--check');
  const progress = process.argv.includes('--progress');
  const maxChars = intEnv('MAX_CHARS', COMPACTOR_MAX_CHARS);
  const targetChars = intEnv('TARGET_CHARS', COMPACTOR_TARGET_CHARS);

  const guides = readGuides(listTrackedGuides());
  const measurements = measureGuides(guides, { maxChars });
  const oversized = selectOversized(measurements);
  const maxGuides = intEnv('MAX_GUIDES', DEFAULT_MAX_GUIDES);
  const worklistGuides = selectWorklist(measurements, { maxGuides });
  const report = formatReport(measurements, { maxChars });

  logMeasurements(measurements, maxChars);

  if (progress) {
    runProgressCheck(measurements, { maxChars, targetChars });
    return;
  }

  if (check) {
    writeSummary(`## CLAUDE.md size check\n\n${report}`);
    // Two invariants: every guide must be under the max, and the ones Claude was
    // actually asked to rewrite must have reached the target it was given.
    const worklist = parseWorklist(process.env.WORKLIST);
    const missedTarget = selectAboveTarget(measurements, { worklist, targetChars });
    for (const m of missedTarget) {
      console.error(
        `::error file=${m.path}::${m.path} is ${m.chars} chars; it was selected for compaction to at most ${targetChars}.`
      );
    }
    // With a worklist (one-file-per-run), other oversized guides are deferred
    // to a later Saturday — they must not fail this check. Without a worklist,
    // every tracked guide must be under MAX_CHARS (the original invariant).
    const checkFailed = worklist.length > 0 ? missedTarget.length > 0 : oversized.length > 0;
    if (worklist.length === 0) {
      for (const m of oversized) {
        console.error(
          `::error file=${m.path}::${m.path} is ${m.chars} chars, policy limit ${maxChars}.`
        );
      }
    }
    if (checkFailed) {
      console.error(
        `❌ ${oversized.length} guide(s) at or above ${maxChars} chars; ${missedTarget.length} selected guide(s) above the ${targetChars}-char target.`
      );
      process.exit(1);
    }
    const scope =
      worklist.length > 0
        ? ` and ${worklist.length} rewritten guide(s) at or below ${targetChars}`
        : '';
    console.log(
      `✅ All ${measurements.length} tracked guides are below ${maxChars} chars${scope}.`
    );
    return;
  }

  const branch = buildBranchName(new Date());
  let existing = null;
  if (worklistGuides.length > 0 && (process.env.SKIP_PR_CHECK ?? '').trim() !== '1') {
    const repo = requireEnv('REPO');
    const token = requireEnv('GH_TOKEN');
    existing = findExistingCompactionPr(await fetchOpenPrs(repo, token));
  }

  setOutput('has_oversized', worklistGuides.length > 0 ? 'true' : 'false');
  setOutput('oversized_count', String(worklistGuides.length));
  // Carried into the post-Claude --check step: after a successful rewrite these
  // paths no longer look oversized, so the check cannot rediscover them.
  setOutput('worklist', worklistGuides.map((m) => m.path).join(','));
  // Pre-Claude sizes of EVERY oversized guide (not just the worklist) so
  // --progress can tell a deferred leftover from a newly oversized file.
  setOutput('before_sizes', formatBeforeSizes(oversized));
  setOutput('branch', branch);
  // The workflow, not Claude, opens the PR; exporting the title keeps the
  // `gh pr create` step and the brief on one constant.
  setOutput('pr_title', COMPACTION_PR_TITLE);
  setOutput('existing_pr', existing?.url ?? '');
  setOutput('report', report);
  setOutput(
    'prompt',
    worklistGuides.length > 0
      ? buildPrompt({ oversized: worklistGuides, maxChars, targetChars, branch, report })
      : ''
  );

  writeSummary(`## Weekend CLAUDE.md compaction\n\n${report}`);

  if (worklistGuides.length === 0) {
    console.log('✅ Nothing oversized — clean no-op, no branch and no PR.');
    return;
  }
  if (existing) {
    console.log(`⏭️  A compaction PR is already open: ${existing.url} — skipping this run.`);
    return;
  }
  const deferred = oversized.length - worklistGuides.length;
  const deferNote = deferred > 0 ? ` (${deferred} further oversized guide(s) deferred)` : '';
  console.log(`🧹 ${worklistGuides.length} guide(s) to compact on branch ${branch}${deferNote}.`);
}

main().catch((err) => {
  console.error(`❌ CLAUDE.md compactor measurement failed: ${err.message?.split('\n')[0] ?? err}`);
  process.exit(1);
});
