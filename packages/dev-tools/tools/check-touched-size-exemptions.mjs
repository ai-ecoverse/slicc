#!/usr/bin/env node
// PR-level "boy-scout" gate for the function-size debt list.
//
// Computes the PR's changed files via `git diff --name-only <base>...HEAD`
// and intersects them with the size-exemption globs parsed from `biome.json`
// (see size-exemption-lib.mjs). Exits non-zero with a fix-it message if any
// touched file is still on the debt list — the PR author must refactor the
// file under the function-size cap and delete its `overrides` entry in the
// same PR. Skips gracefully on non-PR events.
//
// Usage:
//   node packages/dev-tools/tools/check-touched-size-exemptions.mjs [base-ref]
//   CHANGED_FILES=path1,path2 node packages/dev-tools/tools/check-touched-size-exemptions.mjs
//
// Base-ref resolution order:
//   1. positional arg
//   2. $GITHUB_BASE_REF (set on `pull_request` events)
//   3. $BASE_REF
//   4. fallback "origin/main"

import { spawnSync } from 'node:child_process';
import {
  extractSizeExemptionGlobs,
  findTouchedExemptions,
  readBiomeConfig,
  repoRoot,
} from './size-exemption-lib.mjs';

function resolveBaseRef(argv) {
  if (argv[2]) return argv[2];
  if (process.env.GITHUB_BASE_REF) return `origin/${process.env.GITHUB_BASE_REF}`;
  if (process.env.BASE_REF) return process.env.BASE_REF;
  return 'origin/main';
}

function getChangedFilesFromEnv() {
  const raw = process.env.CHANGED_FILES;
  if (!raw) return null;
  return raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function runGit(args) {
  const r = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf-8' });
  if (r.status !== 0) {
    const err = (r.stderr || '').trim() || `git ${args.join(' ')} failed`;
    throw new Error(err);
  }
  return r.stdout.trim();
}

function getChangedFilesFromGit(baseRef) {
  const mergeBase = runGit(['merge-base', baseRef, 'HEAD']);
  // Diff working tree against merge-base. In CI (clean checkout) this matches
  // `${mergeBase}..HEAD`; locally it additionally surfaces uncommitted work
  // so the gate is useful as a pre-commit check.
  const out = runGit(['diff', '--name-only', mergeBase]);
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function isPullRequestEvent() {
  return process.env.GITHUB_EVENT_NAME === 'pull_request' || !!process.env.GITHUB_BASE_REF;
}

function main() {
  // Skip gracefully on non-PR CI events (push, merge_group). The gate is
  // PR-only by design; merge_group runs against the queue commit and has no
  // meaningful merge base to diff against.
  if (process.env.GITHUB_ACTIONS === 'true' && !isPullRequestEvent()) {
    console.log('check-touched-size-exemptions: skipped (not a pull_request event)');
    return 0;
  }

  const biomeConfig = readBiomeConfig();
  const exemptions = extractSizeExemptionGlobs(biomeConfig);
  if (exemptions.length === 0) {
    console.log(
      'check-touched-size-exemptions: no debt list found in biome.json — nothing to gate'
    );
    return 0;
  }

  let changedFiles;
  const envFiles = getChangedFilesFromEnv();
  if (envFiles) {
    changedFiles = envFiles;
  } else {
    const baseRef = resolveBaseRef(process.argv);
    try {
      changedFiles = getChangedFilesFromGit(baseRef);
    } catch (err) {
      console.error(`check-touched-size-exemptions: ${err.message}`);
      console.error(
        'Hint: in CI, checkout with `fetch-depth: 0` so the merge-base can be resolved.'
      );
      return 2;
    }
  }

  const touched = findTouchedExemptions(changedFiles, exemptions);
  if (touched.length === 0) {
    console.log(
      `check-touched-size-exemptions: OK (${changedFiles.length} changed file(s), 0 still on the debt list)`
    );
    return 0;
  }

  console.error('check-touched-size-exemptions: FAIL');
  console.error('');
  console.error('The following changed files are still on the function-size debt list');
  console.error('(biome.json `overrides` → complexity.noExcessiveLinesPerFunction = off):');
  console.error('');
  for (const f of touched) console.error(`  - ${f}`);
  console.error('');
  console.error('Fix: in this same PR, refactor each file so every function is under the');
  console.error('configured biome cap (complexity.noExcessiveLinesPerFunction.maxLines), then');
  console.error('remove its entry from the debt-list `overrides` block in biome.json.');
  return 1;
}

process.exit(main());
