#!/usr/bin/env node
// PR-level "boy-scout" gate for the repo's debt / exemption lists.
//
// Computes the PR's changed files via `git diff --name-only <base>...HEAD` and
// enforces, per debt list (see debt-list-sources.mjs for the registry and the
// reasoning behind the differing semantics):
//
//   - biome complexity debt lists (function-size, cognitive-complexity):
//     frozen AND subject to the touched-file rule — a PR that changes a listed
//     file must bring every function under the biome cap and delete the
//     `overrides` entry in the same PR.
//   - biome non-complexity rule-disabling overrides, `coverageExclude` in
//     coverage-thresholds.json, `ignore` in jscpd.json: frozen only. These
//     lists legitimately contain permanent entries, so touching a listed file
//     is fine; growing the list is not.
//   - knip ignores: reported only, never fails.
//
// Every list carries the bootstrapping exemption: entries in a scope the base
// ref does not have at all are being introduced, not grown, and are ignored.
// Base-config reads are non-throwing: an unreadable base skips that list's
// growth check rather than failing the build.
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
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DEBT_LIST_SOURCES,
  evaluateDebtSource,
  evaluateRuleDebtList,
  formatGrowthReport,
  formatTouchedReport,
} from './debt-list-sources.mjs';
import {
  COMPLEXITY_RULE_KEY,
  extractExemptionGlobsFor,
  repoRoot,
  SIZE_RULE_KEY,
} from './size-exemption-lib.mjs';

const SCRIPT = 'check-touched-exemptions';

const COMPLEXITY_GROWTH_FIX_IT =
  'Fix: bring every function in the file under the configured per-function biome cap\n' +
  'instead of adding it to the debt list.';

const RULES = [
  {
    id: 'function-size',
    key: SIZE_RULE_KEY,
    label: 'function-size',
    file: 'biome.json',
    location: 'biome.json `overrides` → complexity.noExcessiveLinesPerFunction = off',
    semantics: { touched: true, freeze: true, failOnGrowth: true },
    touchedFixIt:
      'Fix: in this same PR, refactor each file so every function is under the\n' +
      'configured biome cap (complexity.noExcessiveLinesPerFunction.maxLines), then\n' +
      'remove its entry from the debt-list `overrides` block in biome.json.',
    growthFixIt: COMPLEXITY_GROWTH_FIX_IT,
  },
  {
    id: 'cognitive-complexity',
    key: COMPLEXITY_RULE_KEY,
    label: 'cognitive-complexity',
    file: 'biome.json',
    location: 'biome.json `overrides` → complexity.noExcessiveCognitiveComplexity = off',
    semantics: { touched: true, freeze: true, failOnGrowth: true },
    touchedFixIt:
      "Fix: in this same PR, refactor each file so every function's cognitive\n" +
      'complexity is under the configured biome cap\n' +
      '(complexity.noExcessiveCognitiveComplexity.maxAllowedComplexity), then\n' +
      'remove its entry from the debt-list `overrides` block in biome.json.',
    growthFixIt: COMPLEXITY_GROWTH_FIX_IT,
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

function readCurrentConfig(file) {
  return JSON.parse(readFileSync(resolve(repoRoot, file), 'utf-8'));
}

// Read and parse a config file from the BASE ref via `git show <ref>:<file>`.
// Returns null on ANY failure (missing ref, missing file, unfetched base,
// malformed JSON). Intentionally non-throwing so a missing base config skips
// that list's growth check rather than failing the build.
function readBaseConfig(baseRef, file) {
  try {
    return JSON.parse(runGit(['show', `${baseRef}:${file}`]));
  } catch {
    return null;
  }
}

function makeConfigReaders(baseRef) {
  const current = new Map();
  const base = new Map();
  return {
    current(file) {
      if (!current.has(file)) {
        try {
          current.set(file, readCurrentConfig(file));
        } catch {
          current.set(file, null);
        }
      }
      return current.get(file);
    },
    base(file) {
      if (!base.has(file)) base.set(file, readBaseConfig(baseRef, file));
      return base.get(file);
    },
  };
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

function evaluateAll({ readers, changedFiles }) {
  const results = [];
  for (const rule of RULES) {
    const config = readers.current(rule.file);
    const baseConfig = readers.base(rule.file);
    results.push(
      evaluateRuleDebtList(rule, {
        currentGlobs: extractExemptionGlobsFor(config, rule.key),
        baseGlobs: extractExemptionGlobsFor(baseConfig, rule.key),
        baseAvailable: baseConfig !== null,
        changedFiles,
      })
    );
  }
  for (const source of DEBT_LIST_SOURCES) {
    const config = readers.current(source.file);
    const baseConfig = readers.base(source.file);
    results.push(
      evaluateDebtSource(source, {
        currentEntries: config === null ? [] : source.extract(config),
        baseEntries: baseConfig === null ? [] : source.extract(baseConfig),
        baseAvailable: baseConfig !== null,
      })
    );
  }
  return results;
}

function reportSkips(results) {
  for (const r of results) {
    if (r.skipReason) {
      console.log(`${SCRIPT}: notice — ${r.source.label} growth check skipped (${r.skipReason})`);
    }
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

  const resolved = resolveChangedFiles();
  if (resolved.error) {
    console.error(`${SCRIPT}: ${resolved.error}`);
    console.error('Hint: in CI, checkout with `fetch-depth: 0` so the merge-base can be resolved.');
    return 2;
  }
  const { changedFiles } = resolved;

  const readers = makeConfigReaders(resolveBaseRef(process.argv));
  const results = evaluateAll({ readers, changedFiles });
  reportSkips(results);

  const failures = results.filter((r) => r.failed);
  const warnings = results.filter((r) => r.warned);

  for (const result of warnings) {
    for (const line of formatGrowthReport(result)) console.log(line);
  }

  if (failures.length === 0) {
    console.log(`${SCRIPT}: OK (${changedFiles.length} changed file(s), 0 still on any debt list)`);
    return 0;
  }

  console.error(`${SCRIPT}: FAIL`);
  for (const result of failures) {
    if (result.touched?.length) {
      for (const line of formatTouchedReport(result)) console.error(line);
    }
    if (result.added.length) {
      for (const line of formatGrowthReport(result)) console.error(line);
    }
  }
  return 1;
}

process.exit(main());
