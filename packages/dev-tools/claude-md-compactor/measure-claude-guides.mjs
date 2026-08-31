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
 * Modes:
 *   (default)  Measure + query open PRs for the claimed-file set, then write
 *              `has_oversized`, `oversized_count`, `matrix` (dynamic Actions
 *              include), `branch`, `existing_pr`, `before_sizes`, `report`,
 *              and `prompt` to $GITHUB_OUTPUT. Always exits 0 when measurement
 *              succeeds, including the clean no-op. An open compaction PR no
 *              longer skips the run — those PR's CLAUDE.md files are dropped
 *              from the worklist (boy-scout claimed-file rule) so the rest
 *              still fan out.
 *   --check    Measure only and FAIL (exit 1) if any tracked guide is still at
 *              or above MAX_CHARS, or if any guide named in WORKLIST is above
 *              TARGET_CHARS. This is the post-compaction invariant, run
 *              deterministically by the workflow instead of trusted to the
 *              model. No GitHub API access, no outputs beyond the summary.
 *   --progress Compare the working tree to BEFORE_SIZES. Exit 0 when
 *              `openPr` (policy hit or recovered partial); write a PR body
 *              to $PR_BODY_FILE if Claude left it empty. Exit 1 when nothing
 *              got smaller (Saturday 2026-08-30: Claude ran, every selected
 *              guide was still at its pre-run size).
 *   --publish-paths After --progress: write the docs/CLAUDE.md files Claude
 *              actually edited (minus the workflow PR's own files) to
 *              $PUBLISH_PATHS_FILE so a shard can copy them into an artifact.
 *   --pack     Per-shard: --progress + --publish-paths, copy those files into
 *              $PACK_DIR (progress.json + files/ tree). Exit 0 with
 *              `packed=false` when there is nothing to publish.
 *   --assemble Consolidate job: read every shard under $PACKS_DIR, merge
 *              progress into one PR body, write the combined path list.
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
 *   MAX_GUIDES     how many oversized guides to fan out this run
 *                  (default 0 = all, largest first). A positive cap is largest N.
 *   GUIDE          optional single path: this shard's worklist (compact job).
 *   MAX_TURNS      override computed --max-turns (300 × worklist + overflow)
 *   WORKLIST       --check/--progress/--pack: comma/newline-separated guide
 *                  paths that were handed to Claude, held to TARGET_CHARS
 *                  instead of MAX_CHARS. Emitted as the `worklist` output by
 *                  the measuring run, since a rewritten guide no longer looks
 *                  oversized.
 *   PACK_DIR       --pack: directory to write progress.json + files/
 *   PACKS_DIR      --assemble: directory of per-shard PACK_DIR trees
 *   ASSEMBLE_PATHS_FILE --assemble: combined publish path list
 *   BEFORE_SIZES   --progress: JSON object of path → pre-Claude char counts
 *                  (the measure step's `before_sizes` output).
 *   PR_BODY_FILE   --progress: write a synthesised partial-PR body here when
 *                  Claude left the file missing or empty.
 *   SHRUNK_PATHS_FILE --progress: newline-separated worklist paths that shrank,
 *                  so the workflow can `git add` leftover working-tree edits.
 *   ORIG_SHA       --publish-paths: pre-Claude checkout SHA (`github.sha`)
 *   PUBLISH_PATHS_FILE --publish-paths: output path list to copy onto origin/main
 *   SKIP_PR_CHECK  '1' to skip the open-PR dedup query (offline runs)
 *   GITHUB_OUTPUT / GITHUB_STEP_SUMMARY  Actions files, written when present
 *
 * Exit 0 on a clean run (work found or not); 1 on a --check violation, a
 * --progress with no recoverable shrinkage, or an unexpected API failure; 2
 * on missing required env.
 */
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assessCompactionProgress,
  blockedGuidePaths,
  buildBranchName,
  buildCompactionPrBody,
  buildCompactMatrix,
  buildPrompt,
  COMPACTION_PR_TITLE,
  COMPACTOR_MAX_CHARS,
  COMPACTOR_TARGET_CHARS,
  computeMaxTurns,
  DEFAULT_MAX_GUIDES,
  excludeBlockedGuides,
  findExistingCompactionPr,
  formatBeforeSizes,
  formatProgressReport,
  formatReport,
  listCompactionPrs,
  measureGuides,
  mergeShardProgress,
  parseBeforeSizes,
  parseMaxGuides,
  parseWorklist,
  selectAboveTarget,
  selectOversized,
  selectPublishPaths,
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

/** Changed files on one PR (one page — compaction PRs are a handful of docs). */
async function fetchPrFiles(repo, token, number) {
  const res = await fetch(`${API}/repos/${repo}/pulls/${number}/files?per_page=100`, {
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
      `GET /repos/${repo}/pulls/${number}/files → ${res.status} ${res.statusText} ${body.slice(0, 200)}`
    );
  }
  return res.json();
}

/** CLAUDE.md paths already in open compaction PRs. */
async function claimedGuidePaths(repo, token, openPrs) {
  const claimed = [];
  for (const pr of listCompactionPrs(openPrs)) {
    if (pr.number == null) continue;
    claimed.push(...blockedGuidePaths(await fetchPrFiles(repo, token, pr.number)));
  }
  return claimed;
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

function gitNames(args) {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Files Claude actually edited that may be copied onto origin/main. Excludes
 * the workflow PR's own files so a dispatch from a feature branch cannot leak
 * YAML/docs into the compaction PR.
 */
function computePublishPaths() {
  const orig = requireEnv('ORIG_SHA');
  let shrunk = [];
  const shrunkFile = (process.env.SHRUNK_PATHS_FILE ?? '').trim();
  if (shrunkFile) {
    try {
      shrunk = readFileSync(shrunkFile, 'utf8')
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
    } catch {
      shrunk = [];
    }
  }
  const claudeTouched = [
    ...gitNames(['diff', '--name-only', orig, 'HEAD']),
    ...gitNames(['diff', '--name-only', 'HEAD']),
    ...gitNames(['diff', '--name-only', '--cached']),
  ];
  const workflowTouched = gitNames(['diff', '--name-only', 'origin/main', orig]);
  return selectPublishPaths({ claudeTouched, workflowTouched, shrunk });
}

function runPublishPaths() {
  const outFile = requireEnv('PUBLISH_PATHS_FILE');
  const paths = computePublishPaths();
  writeFileSync(outFile, paths.length > 0 ? `${paths.join('\n')}\n` : '');
  if (paths.length === 0) {
    console.error('❌ No compaction files to publish onto origin/main.');
    process.exit(1);
  }
  console.log(`Publishing ${paths.length} file(s) onto origin/main:`);
  for (const p of paths) console.log(`  ${p}`);
}

function copyIntoPack(packDir, path) {
  const dest = join(packDir, 'files', path);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(resolve(repoRoot, path), dest);
}

/**
 * Per-shard pack: keep whatever this Claude job shrank so the consolidate job
 * can overlay every shard onto origin/main. Exit 0 even when there is nothing
 * to pack — a max-turns miss with no shrinkage must not fail the matrix leg
 * (other shards still publish).
 */
function runPack(measurements, { maxChars, targetChars }) {
  const packDir = requireEnv('PACK_DIR');
  mkdirSync(packDir, { recursive: true });
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

  const shrunkFile = (process.env.SHRUNK_PATHS_FILE ?? '').trim();
  if (shrunkFile) {
    const lines = assessment.shrunk.map((r) => r.path);
    writeFileSync(shrunkFile, lines.length > 0 ? `${lines.join('\n')}\n` : '');
  }

  if (!assessment.openPr) {
    setOutput('packed', 'false');
    console.log('Nothing to pack from this shard.');
    return;
  }

  const paths = computePublishPaths();
  if (paths.length === 0) {
    setOutput('packed', 'false');
    console.log('Nothing to pack from this shard.');
    return;
  }

  const after = worklist
    .map((path) => measurements.find((m) => m.path === path))
    .filter(Boolean)
    .map((m) => ({ path: m.path, chars: m.chars, oversized: m.oversized }));
  writeFileSync(
    join(packDir, 'progress.json'),
    `${JSON.stringify({
      worklist,
      before: Object.fromEntries([...before.entries()]),
      after,
      paths,
    })}\n`
  );
  writeFileSync(join(packDir, 'paths.txt'), `${paths.join('\n')}\n`);
  for (const p of paths) {
    if (!existsSync(resolve(repoRoot, p))) {
      console.error(`::error::${p} was selected to pack but is missing from the working tree.`);
      process.exit(1);
    }
    copyIntoPack(packDir, p);
  }
  setOutput('packed', 'true');
  console.log(`Packed ${paths.length} file(s):`);
  for (const p of paths) console.log(`  ${p}`);
}

function runAssemble({ maxChars, targetChars }) {
  const packsDir = requireEnv('PACKS_DIR');
  const shards = [];
  const allPaths = [];
  const seen = new Set();
  let entries = [];
  try {
    entries = readdirSync(packsDir, { withFileTypes: true });
  } catch {
    console.error(`❌ PACKS_DIR ${packsDir} is not a directory.`);
    process.exit(1);
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const progressFile = join(packsDir, ent.name, 'progress.json');
    let shard;
    try {
      shard = JSON.parse(readFileSync(progressFile, 'utf8'));
    } catch {
      continue;
    }
    shards.push(shard);
    for (const p of shard.paths ?? []) {
      if (!p || seen.has(p)) continue;
      seen.add(p);
      allPaths.push(p);
    }
  }
  if (shards.length === 0 || allPaths.length === 0) {
    console.error('❌ No compaction files to publish onto origin/main.');
    process.exit(1);
  }
  const assessment = mergeShardProgress(shards, { maxChars, targetChars });
  const progress = formatProgressReport(assessment, { maxChars, targetChars });
  writeSummary(`## CLAUDE.md compaction progress\n\n${progress}`);
  console.log(progress);

  const bodyFile = (process.env.PR_BODY_FILE ?? '').trim();
  if (bodyFile && existingBody(bodyFile).trim() === '') {
    writeFileSync(bodyFile, buildCompactionPrBody(assessment, { maxChars, targetChars }));
    console.log(`Wrote PR body to ${bodyFile}`);
  }
  const pathsFile = (process.env.ASSEMBLE_PATHS_FILE ?? '').trim();
  if (pathsFile) writeFileSync(pathsFile, `${allPaths.join('\n')}\n`);
  setOutput('packed_shards', String(shards.length));
  console.log(`Assembled ${shards.length} shard(s), ${allPaths.length} file(s):`);
  for (const p of allPaths) console.log(`  ${p}`);
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

  if (assessment.openPr) {
    const bodyFile = (process.env.PR_BODY_FILE ?? '').trim();
    if (bodyFile && existingBody(bodyFile).trim() === '') {
      writeFileSync(bodyFile, buildCompactionPrBody(assessment, { maxChars, targetChars }));
      console.log(`Wrote PR body to ${bodyFile}`);
    }
    if (assessment.recovered) {
      console.log(
        `⚠️ Policy target missed, but ${assessment.shrunk.length} selected guide(s) got smaller — recovering with a partial PR.`
      );
    } else {
      console.log('✅ Policy already met — publishing the compacted guides.');
    }
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

function runCheck(measurements, oversized, { maxChars, targetChars }) {
  const report = formatReport(measurements, { maxChars });
  writeSummary(`## CLAUDE.md size check\n\n${report}`);
  const worklist = parseWorklist(process.env.WORKLIST);
  const missedTarget = selectAboveTarget(measurements, { worklist, targetChars });
  for (const m of missedTarget) {
    console.error(
      `::error file=${m.path}::${m.path} is ${m.chars} chars; it was selected for compaction to at most ${targetChars}.`
    );
  }
  // With a worklist, other oversized guides are other shards (or deferred
  // leftovers) — they must not fail this check. Without a worklist, every
  // tracked guide must be under MAX_CHARS (the original invariant).
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
  console.log(`✅ All ${measurements.length} tracked guides are below ${maxChars} chars${scope}.`);
}

async function resolveWorklist(measurements, selected) {
  const forced = parseWorklist(process.env.GUIDE);
  if (forced.length > 0) {
    return {
      worklistGuides: measurements.filter((m) => forced.includes(m.path) && m.oversized),
      existing: null,
      blocked: [],
    };
  }
  if (selected.length === 0 || (process.env.SKIP_PR_CHECK ?? '').trim() === '1') {
    return { worklistGuides: selected, existing: null, blocked: [] };
  }
  const repo = requireEnv('REPO');
  const token = requireEnv('GH_TOKEN');
  const openPrs = await fetchOpenPrs(repo, token);
  const existing = findExistingCompactionPr(openPrs);
  const blocked = await claimedGuidePaths(repo, token, openPrs);
  return {
    worklistGuides: excludeBlockedGuides(selected, blocked),
    existing,
    blocked,
  };
}

function emitMeasureOutputs({
  worklistGuides,
  oversized,
  maxChars,
  targetChars,
  branch,
  existing,
  report,
}) {
  setOutput('has_oversized', worklistGuides.length > 0 ? 'true' : 'false');
  setOutput('oversized_count', String(worklistGuides.length));
  setOutput('matrix', JSON.stringify(buildCompactMatrix(worklistGuides, { targetChars })));
  setOutput(
    'max_turns',
    String(intEnv('MAX_TURNS', computeMaxTurns(worklistGuides, { targetChars })))
  );
  setOutput('worklist', worklistGuides.map((m) => m.path).join(','));
  setOutput('before_sizes', formatBeforeSizes(oversized));
  setOutput('branch', branch);
  setOutput('pr_title', COMPACTION_PR_TITLE);
  setOutput('existing_pr', existing?.url ?? '');
  setOutput('report', report);
  setOutput(
    'prompt',
    worklistGuides.length > 0
      ? buildPrompt({ oversized: worklistGuides, maxChars, targetChars, branch, report })
      : ''
  );
}

function logMeasureResult({ worklistGuides, selected, oversized, blocked, existing, branch }) {
  if (worklistGuides.length === 0) {
    if (blocked.length > 0 && selected.length > 0) {
      console.log(
        `⏭️  Every oversized guide is already in an open compaction PR (${existing?.url ?? 'unknown'}) — skipping.`
      );
      return;
    }
    console.log('✅ Nothing oversized — clean no-op, no branch and no PR.');
    return;
  }
  if (blocked.length > 0) {
    console.log(
      `⏭️  Skipping ${blocked.length} guide(s) already in ${existing?.url ?? 'an open compaction PR'}: ${blocked.join(', ')}`
    );
  }
  const claimedOversized = blocked.filter((p) => oversized.some((m) => m.path === p)).length;
  const deferred = oversized.length - worklistGuides.length - claimedOversized;
  const deferNote =
    deferred > 0 ? ` (${deferred} further oversized guide(s) capped by MAX_GUIDES)` : '';
  console.log(
    `🧹 ${worklistGuides.length} guide(s) to compact across parallel shards, then one PR on ${branch}${deferNote}.`
  );
}

async function main() {
  const check = process.argv.includes('--check');
  const progress = process.argv.includes('--progress');
  const publishPaths = process.argv.includes('--publish-paths');
  const pack = process.argv.includes('--pack');
  const assemble = process.argv.includes('--assemble');
  const maxChars = intEnv('MAX_CHARS', COMPACTOR_MAX_CHARS);
  const targetChars = intEnv('TARGET_CHARS', COMPACTOR_TARGET_CHARS);
  if (publishPaths) {
    runPublishPaths();
    return;
  }
  if (assemble) {
    runAssemble({ maxChars, targetChars });
    return;
  }

  const measurements = measureGuides(readGuides(listTrackedGuides()), { maxChars });
  const oversized = selectOversized(measurements);
  const selected = selectWorklist(measurements, {
    maxGuides: parseMaxGuides(process.env.MAX_GUIDES, DEFAULT_MAX_GUIDES),
  });
  const report = formatReport(measurements, { maxChars });
  logMeasurements(measurements, maxChars);

  if (pack) {
    runPack(measurements, { maxChars, targetChars });
    return;
  }
  if (progress) {
    runProgressCheck(measurements, { maxChars, targetChars });
    return;
  }
  if (check) {
    runCheck(measurements, oversized, { maxChars, targetChars });
    return;
  }

  const branch = buildBranchName(new Date(), process.env.GITHUB_RUN_ID);
  const { worklistGuides, existing, blocked } = await resolveWorklist(measurements, selected);
  emitMeasureOutputs({
    worklistGuides,
    oversized,
    maxChars,
    targetChars,
    branch,
    existing,
    report,
  });
  writeSummary(`## Weekend CLAUDE.md compaction\n\n${report}`);
  logMeasureResult({ worklistGuides, selected, oversized, blocked, existing, branch });
}

main().catch((err) => {
  console.error(`❌ CLAUDE.md compactor measurement failed: ${err.message?.split('\n')[0] ?? err}`);
  process.exit(1);
});
