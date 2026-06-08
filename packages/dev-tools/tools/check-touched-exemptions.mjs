#!/usr/bin/env node
// PR-level "boy-scout" gate for both biome complexity debt lists.
//
// Computes the PR's changed files via `git diff --name-only <base>...HEAD`
// and intersects them with BOTH per-rule exemption globs parsed from
// `biome.json` (see size-exemption-lib.mjs): the function-size debt list
// (`complexity.noExcessiveLinesPerFunction: "off"`) and the cognitive-
// complexity debt list (`complexity.noExcessiveCognitiveComplexity: "off"`).
// Exits non-zero with a rule-appropriate fix-it message if any touched file
// is still on EITHER list — the PR author must bring the file under the
// configured biome cap and delete its `overrides` entry in the same PR.
// Skips gracefully on non-PR events.
//
// Usage:
//   node packages/dev-tools/tools/check-touched-exemptions.mjs [base-ref]
//   CHANGED_FILES=path1,path2 node packages/dev-tools/tools/check-touched-exemptions.mjs
//
// Base-ref resolution order:
//   1. positional arg
//   2. $GITHUB_BASE_REF (set on `pull_request` events)
//   3. $BASE_REF
//   4. fallback "origin/main"

import { spawnSync } from 'node:child_process';
import {
  COMPLEXITY_RULE_KEY,
  extractExemptionGlobsFor,
  findTouchedExemptions,
  readBiomeConfig,
  repoRoot,
  SIZE_RULE_KEY,
} from './size-exemption-lib.mjs';

const SCRIPT = 'check-touched-exemptions';

const RULES = [
  {
    key: SIZE_RULE_KEY,
    label: 'function-size',
    overrideName: 'complexity.noExcessiveLinesPerFunction',
    fixIt:
      'Fix: in this same PR, refactor each file so every function is under the\n' +
      'configured biome cap (complexity.noExcessiveLinesPerFunction.maxLines), then\n' +
      'remove its entry from the debt-list `overrides` block in biome.json.',
  },
  {
    key: COMPLEXITY_RULE_KEY,
    label: 'cognitive-complexity',
    overrideName: 'complexity.noExcessiveCognitiveComplexity',
    fixIt:
      "Fix: in this same PR, reduce each file's cognitive complexity under the\n" +
      'configured biome cap (complexity.noExcessiveCognitiveComplexity.maxAllowedComplexity),\n' +
      'then remove its entry from the debt-list `overrides` block in biome.json.',
  },
];

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

function resolveChangedFiles() {
  const envFiles = getChangedFilesFromEnv();
  if (envFiles) return { changedFiles: envFiles };
  const baseRef = resolveBaseRef(process.argv);
  try {
    return { changedFiles: getChangedFilesFromGit(baseRef) };
  } catch (err) {
    return { error: err.message };
  }
}

function main() {
  // Skip gracefully on non-PR CI events (push, merge_group). The gate is
  // PR-only by design; merge_group runs against the queue commit and has no
  // meaningful merge base to diff against.
  if (process.env.GITHUB_ACTIONS === 'true' && !isPullRequestEvent()) {
    console.log(`${SCRIPT}: skipped (not a pull_request event)`);
    return 0;
  }

  const biomeConfig = readBiomeConfig();
  const ruleStates = RULES.map((rule) => ({
    ...rule,
    globs: extractExemptionGlobsFor(biomeConfig, rule.key),
  }));

  if (ruleStates.every((r) => r.globs.length === 0)) {
    console.log(`${SCRIPT}: no debt lists found in biome.json — nothing to gate`);
    return 0;
  }

  const resolved = resolveChangedFiles();
  if (resolved.error) {
    console.error(`${SCRIPT}: ${resolved.error}`);
    console.error('Hint: in CI, checkout with `fetch-depth: 0` so the merge-base can be resolved.');
    return 2;
  }
  const { changedFiles } = resolved;

  const violations = ruleStates
    .map((rule) => ({ rule, touched: findTouchedExemptions(changedFiles, rule.globs) }))
    .filter((v) => v.touched.length > 0);

  if (violations.length === 0) {
    console.log(`${SCRIPT}: OK (${changedFiles.length} changed file(s), 0 still on any debt list)`);
    return 0;
  }

  console.error(`${SCRIPT}: FAIL`);
  for (const { rule, touched } of violations) {
    console.error('');
    console.error(`The following changed files are still on the ${rule.label} debt list`);
    console.error(`(biome.json \`overrides\` → ${rule.overrideName} = off):`);
    console.error('');
    for (const f of touched) console.error(`  - ${f}  [${rule.label}]`);
    console.error('');
    console.error(rule.fixIt);
  }
  return 1;
}

process.exit(main());
