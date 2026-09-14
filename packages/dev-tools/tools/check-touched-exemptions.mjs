#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { baselineFiles, BASELINE_PATH as LAYER_BASELINE_PATH } from './check-layer-back-edges.mjs';
import { BASELINE_PATH as FLOAT_PROBE_BASELINE_PATH } from './check-no-float-probes.mjs';
import { BASELINE_PATH as RECORD_BASELINE_PATH } from './check-record-string-unknown.mjs';
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

const LAYER_BASELINE_REL = relative(repoRoot, LAYER_BASELINE_PATH).split('\\').join('/');
const RECORD_BASELINE_REL = relative(repoRoot, RECORD_BASELINE_PATH).split('\\').join('/');
const FLOAT_PROBE_BASELINE_REL = relative(repoRoot, FLOAT_PROBE_BASELINE_PATH)
  .split('\\')
  .join('/');

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

  const out = runGit(['diff', '--name-only', mergeBase]);
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function isPullRequestEvent() {
  return process.env.GITHUB_EVENT_NAME === 'pull_request' || !!process.env.GITHUB_BASE_REF;
}

function readBaseJson(baseRef, relPath) {
  try {
    const out = runGit(['show', `${baseRef}:${relPath}`]);
    return JSON.parse(out);
  } catch {
    return null;
  }
}

function readBaselineFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
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
  if (process.env.GITHUB_ACTIONS === 'true' && !isPullRequestEvent() && !getChangedFilesFromEnv()) {
    console.log(`${SCRIPT}: skipped (not a pull_request event)`);
    return 0;
  }

  const biomeConfig = readBiomeConfig();
  const baseRef = resolveBaseRef(process.argv);
  const baseConfig = readBaseJson(baseRef, 'biome.json');
  const layerBaseline = readBaselineFile(LAYER_BASELINE_PATH);
  const baseLayerBaseline = readBaseJson(baseRef, LAYER_BASELINE_REL);
  const recordBaseline = readBaselineFile(RECORD_BASELINE_PATH);
  const baseRecordBaseline = readBaseJson(baseRef, RECORD_BASELINE_REL);
  const floatProbeBaseline = readBaselineFile(FLOAT_PROBE_BASELINE_PATH);
  const baseFloatProbeBaseline = readBaseJson(baseRef, FLOAT_PROBE_BASELINE_REL);
  const ruleStates = [
    ...RULES.map((rule) => ({
      ...rule,
      globs: extractExemptionGlobsFor(biomeConfig, rule.key, rule.group),
      baseGlobs: extractExemptionGlobsFor(baseConfig, rule.key, rule.group),
      baseReadable: baseConfig !== null,
    })),
    {
      label: 'layer-back-edge',
      listRef: LAYER_BASELINE_REL,
      fixIt:
        'Fix: in this same PR, remove every up-the-stack import from the file (move the\n' +
        'pure helper into the lower layer — see docs/review-patterns.md § Layer-stack\n' +
        'import direction), then ratchet the baseline:\n' +
        '  node packages/dev-tools/tools/check-layer-back-edges.mjs --update',
      addFixIt:
        'Fix: remove the new up-the-stack import instead of growing the baseline — move\n' +
        'the pure helper into the lower layer (see docs/review-patterns.md §\n' +
        'Layer-stack import direction).',
      globs: baselineFiles(layerBaseline),
      baseGlobs: baselineFiles(baseLayerBaseline),
      baseReadable: baseLayerBaseline !== null,
    },
    {
      label: 'record-string-unknown',
      listRef: RECORD_BASELINE_REL,
      fixIt:
        'Fix: in this same PR, replace every Record<string, unknown> in the file with a\n' +
        'named type for the shape you actually accept (see docs/review-patterns.md §\n' +
        'Untyped string-keyed bags); for a genuinely untyped payload add\n' +
        '`// biome-ignore lint/plugin: <reason>`. Then ratchet the baseline:\n' +
        '  node packages/dev-tools/tools/check-record-string-unknown.mjs --update',
      addFixIt:
        'Fix: name the shape you actually accept instead of growing the baseline — or, for\n' +
        'a genuinely untyped payload, suppress the line with `// biome-ignore lint/plugin:\n' +
        '<reason>` (see docs/review-patterns.md § Untyped string-keyed bags).',
      globs: baselineFiles(recordBaseline),
      baseGlobs: baselineFiles(baseRecordBaseline),
      baseReadable: baseRecordBaseline !== null,
    },
    {
      label: 'float-probe',
      listRef: FLOAT_PROBE_BASELINE_REL,
      fixIt:
        'Fix: in this same PR, ask the injected CapabilityBroker or take a composition-\n' +
        'time answer instead of re-probing the float (see docs/work-unit.md Phase 6),\n' +
        'then ratchet the baseline:\n' +
        '  node packages/dev-tools/tools/check-no-float-probes.mjs --update',
      addFixIt:
        'Fix: use the injected CapabilityBroker or a composition-time answer instead of\n' +
        'growing the baseline — see docs/work-unit.md Phase 6.',
      globs: baselineFiles(floatProbeBaseline),
      baseGlobs: baselineFiles(baseFloatProbeBaseline),
      baseReadable: baseFloatProbeBaseline !== null,
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

  const touchedViolations = ruleStates
    .map((rule) => ({ rule, touched: findTouchedExemptions(changedFiles, rule.globs) }))
    .filter((v) => v.touched.length > 0);

  for (const rule of ruleStates) {
    if (!rule.baseReadable) {
      console.log(
        `${SCRIPT}: notice — could not read the ${rule.label} debt list at ${baseRef}; ` +
          'skipping its added-entry check'
      );
    }
  }
  const addedViolations = ruleStates
    .filter((rule) => rule.baseReadable)
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
