#!/usr/bin/env node
// PR-level "boy-scout" gate for the repo's debt lists.
//
// Computes the PR's changed files via `git diff --name-only <base>...HEAD`
// and intersects them with EVERY debt list: the per-rule exemption glob lists
// parsed from `biome.json` (see size-exemption-lib.mjs) — function size,
// cognitive complexity, floating promises, and misused promises — plus files
// carrying inline generated layer-boundary suppressions and the legacy `ui/`
// back-edge baseline for directories not yet covered by generated stack rules.
// Exits non-zero with a rule-appropriate fix-it message if any touched file
// is still on ANY list — the PR author must pay the file's debt down and
// delete its entry in the same PR.
// Also exits non-zero if a PR ADDS new entries to any debt list vs the base
// ref (the debt lists are frozen — additions are only allowed when a list
// is being introduced, i.e. base had no entries for that rule).
// During the one-time generated-layer-plugin bootstrap, source files changed
// only by adding generated layer suppressions are excluded from the touched
// check. This closes automatically once the base contains generated plugins.
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
import { relative, resolve } from 'node:path';
import { BASELINE_PATH, baselineFiles } from './check-ui-back-edges.mjs';
import {
  findLayerSuppressionFiles,
  findLayerSuppressionOnlyDiffFiles,
  hasGeneratedLayerPlugins,
} from './layer-boundary-suppressions-lib.mjs';
import {
  COMPLEXITY_RULE_KEY,
  extractExemptionGlobsFor,
  FLOATING_PROMISE_RULE_KEY,
  findAddedExemptions,
  findTouchedExemptions,
  MISUSED_PROMISE_RULE_KEY,
  readBiomeConfig,
  repoRoot,
  SIZE_RULE_KEY,
} from './size-exemption-lib.mjs';

const SCRIPT = 'check-touched-exemptions';
const LAYER_SOURCE_REL = 'packages/webapp/src';
const LAYER_SUPPRESSION = 'biome-ignore lint/plugin/layer-';
const UI_BASELINE_REL = relative(repoRoot, BASELINE_PATH).split('\\').join('/');

const RULES = [
  {
    group: 'complexity',
    key: SIZE_RULE_KEY,
    label: 'function-size',
    listRef: 'biome.json `overrides` → complexity.noExcessiveLinesPerFunction = off',
    fixIt:
      'Fix: in this same PR, refactor each file so every function is under the\n' +
      'configured biome cap (complexity.noExcessiveLinesPerFunction.maxLines), then\n' +
      'remove its entry from the debt-list `overrides` block in biome.json.',
    addFixIt:
      'Fix: bring every function in the file under the configured per-function biome cap\n' +
      'instead of adding it to the function-size debt list.',
  },
  {
    group: 'complexity',
    key: COMPLEXITY_RULE_KEY,
    label: 'cognitive-complexity',
    listRef: 'biome.json `overrides` → complexity.noExcessiveCognitiveComplexity = off',
    fixIt:
      "Fix: in this same PR, refactor each file so every function's cognitive\n" +
      'complexity is under the configured biome cap\n' +
      '(complexity.noExcessiveCognitiveComplexity.maxAllowedComplexity), then\n' +
      'remove its entry from the debt-list `overrides` block in biome.json.',
    addFixIt:
      'Fix: bring every function in the file under the configured per-function biome cap\n' +
      'instead of adding it to the cognitive-complexity debt list.',
  },
  {
    group: 'nursery',
    key: FLOATING_PROMISE_RULE_KEY,
    label: 'floating-promise',
    listRef: 'biome.json `overrides` → nursery.noFloatingPromises = off',
    fixIt:
      'Fix: in this same PR, await, return, or explicitly handle every promise in each\n' +
      'file, then remove its entry from the debt-list `overrides` block in biome.json.',
    addFixIt:
      'Fix: await, return, or explicitly handle every promise in the file instead of\n' +
      'adding it to the floating-promise debt list.',
  },
  {
    group: 'nursery',
    key: MISUSED_PROMISE_RULE_KEY,
    label: 'misused-promise',
    listRef: 'biome.json `overrides` → nursery.noMisusedPromises = off',
    fixIt:
      'Fix: in this same PR, keep promises out of synchronous callback/conditional\n' +
      'positions, then remove the file from the debt-list override in biome.json.',
    addFixIt:
      'Fix: adapt the async callback or condition instead of adding the file to the\n' +
      'misused-promise debt list.',
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

function getLayerDiffFromGit(baseRef) {
  const mergeBase = runGit(['merge-base', baseRef, 'HEAD']);
  return runGit(['diff', '--unified=0', mergeBase, '--', LAYER_SOURCE_REL]);
}

function isPullRequestEvent() {
  return process.env.GITHUB_EVENT_NAME === 'pull_request' || !!process.env.GITHUB_BASE_REF;
}

// Read and parse a JSON file from the BASE ref via `git show <ref>:<path>`.
// Returns the parsed value or null on ANY failure (missing ref, missing file,
// unfetched base, malformed JSON). Intentionally non-throwing so a missing
// base file skips the added-entry check rather than failing the build.
function readBaseJson(baseRef, relPath) {
  try {
    const out = runGit(['show', `${baseRef}:${relPath}`]);
    return JSON.parse(out);
  } catch {
    return null;
  }
}

function readBaseLayerSuppressions(baseRef) {
  const result = spawnSync(
    'git',
    ['grep', '-l', '--fixed-strings', LAYER_SUPPRESSION, baseRef, '--', LAYER_SOURCE_REL],
    { cwd: repoRoot, encoding: 'utf8' }
  );
  if (result.status === 1) return { files: [], readable: true };
  if (result.status !== 0) return { files: [], readable: false };
  const files = result.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(line.indexOf(':') + 1));
  return { files, readable: true };
}

function readUiBaseline() {
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  } catch {
    return null;
  }
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
  const baseRef = resolveBaseRef(process.argv);
  const baseConfig = readBaseJson(baseRef, 'biome.json');
  const layerFiles = findLayerSuppressionFiles(resolve(repoRoot, LAYER_SOURCE_REL), repoRoot);
  const baseLayerFiles = readBaseLayerSuppressions(baseRef);
  const uiBaseline = readUiBaseline();
  const baseUiBaseline = readBaseJson(baseRef, UI_BASELINE_REL);
  const ruleStates = [
    ...RULES.map((rule) => ({
      ...rule,
      globs: extractExemptionGlobsFor(biomeConfig, rule.key, rule.group),
      baseGlobs: extractExemptionGlobsFor(baseConfig, rule.key, rule.group),
      baseReadable: baseConfig !== null,
    })),
    {
      label: 'layer-boundary',
      listRef: `inline ${LAYER_SUPPRESSION} comments under ${LAYER_SOURCE_REL}`,
      fixIt:
        'Fix: in this same PR, remove every suppressed layer back-edge from the file\n' +
        '(move the dependency into a lower-layer module), then remove its now-unused\n' +
        'inline layer-boundary suppression comment.',
      addFixIt:
        'Fix: remove the new layer back-edge instead of adding an inline suppression —\n' +
        'move the dependency into a lower-layer module.',
      globs: layerFiles,
      baseGlobs: baseLayerFiles.files,
      baseReadable: baseLayerFiles.readable,
    },
    {
      label: 'ui-back-edge-legacy',
      listRef: UI_BASELINE_REL,
      fixIt:
        'Fix: in this same PR, remove every `ui/` import from the file (move the pure\n' +
        'helper into a lower-layer module), then ratchet the legacy baseline:\n' +
        '  node packages/dev-tools/tools/check-ui-back-edges.mjs --update',
      addFixIt:
        'Fix: remove the new `ui/` import instead of growing the legacy baseline —\n' +
        'move the dependency into a lower-layer module.',
      globs: baselineFiles(uiBaseline),
      baseGlobs: baselineFiles(baseUiBaseline),
      baseReadable: baseUiBaseline !== null,
    },
  ];

  if (ruleStates.every((r) => r.globs.length === 0)) {
    console.log(`${SCRIPT}: no debt lists found — nothing to gate`);
    return 0;
  }

  const resolved = resolveChangedFiles();
  if (resolved.error) {
    console.error(`${SCRIPT}: ${resolved.error}`);
    console.error('Hint: in CI, checkout with `fetch-depth: 0` so the merge-base can be resolved.');
    return 2;
  }
  const { changedFiles } = resolved;

  let gatedChangedFiles = changedFiles;
  const isLayerBootstrap =
    baseLayerFiles.readable &&
    baseLayerFiles.files.length === 0 &&
    !hasGeneratedLayerPlugins(baseConfig) &&
    hasGeneratedLayerPlugins(biomeConfig);
  if (isLayerBootstrap) {
    try {
      const suppressionOnlyFiles = new Set(
        findLayerSuppressionOnlyDiffFiles(getLayerDiffFromGit(baseRef))
      );
      gatedChangedFiles = changedFiles.filter((file) => !suppressionOnlyFiles.has(file));
      console.log(
        `${SCRIPT}: layer bootstrap — allowing ${suppressionOnlyFiles.size} suppression-only source file touch(es)`
      );
    } catch {
      console.log(
        `${SCRIPT}: notice — could not inspect the layer bootstrap diff; applying the normal touched-file gate`
      );
    }
  }

  const touchedViolations = ruleStates
    .map((rule) => ({ rule, touched: findTouchedExemptions(gatedChangedFiles, rule.globs) }))
    .filter((v) => v.touched.length > 0);

  // Added-entry check: a PR may not GROW any debt list vs the base ref.
  // Bootstrapping exemption: if base has no entries for a rule, the list is
  // being introduced — skip the added-entry check for that rule. If we
  // couldn't read a rule's base list at all, skip the check for that rule (do
  // not fail the build on infra/read errors); the touched-files check still
  // runs.
  for (const rule of ruleStates) {
    if (!rule.baseReadable) {
      console.log(
        `${SCRIPT}: notice — could not read the ${rule.label} debt list at ${baseRef}; ` +
          'skipping its added-entry check'
      );
    }
  }
  const addedViolations = ruleStates
    .filter((rule) => rule.baseReadable && rule.baseGlobs.length > 0)
    .map((rule) => ({ rule, added: findAddedExemptions(rule.baseGlobs, rule.globs) }))
    .filter((v) => v.added.length > 0);

  if (touchedViolations.length === 0 && addedViolations.length === 0) {
    console.log(`${SCRIPT}: OK (${changedFiles.length} changed file(s), 0 still on any debt list)`);
    return 0;
  }

  console.error(`${SCRIPT}: FAIL`);
  for (const { rule, touched } of touchedViolations) {
    console.error('');
    console.error(`The following changed files are still on the ${rule.label} debt list`);
    console.error(`(${rule.listRef}):`);
    console.error('');
    for (const f of touched) console.error(`  - ${f}  [${rule.label}]`);
    console.error('');
    console.error(rule.fixIt);
  }
  for (const { rule, added } of addedViolations) {
    console.error('');
    console.error(
      `The ${rule.label} debt list is frozen and must not grow; this PR adds new entries`
    );
    console.error(`(${rule.listRef}):`);
    console.error('');
    for (const g of added) console.error(`  + ${g}  [${rule.label}]`);
    console.error('');
    console.error(rule.addFixIt);
  }
  return 1;
}

process.exit(main());
