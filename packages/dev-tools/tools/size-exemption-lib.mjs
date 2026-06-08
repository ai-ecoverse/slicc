// Shared logic for the PR-level "boy-scout" debt-list exemption gates.
//
// Biome's `complexity` group hosts two caps that each get a parallel debt
// list in `biome.json`: function size (`noExcessiveLinesPerFunction`) and
// cognitive complexity (`noExcessiveCognitiveComplexity`). For each rule,
// current offenders are listed in dedicated `overrides` blocks that disable
// ONLY that one rule — those blocks are the debt list: they can never grow,
// and any PR that touches a file still on the list must bring it under the
// cap and remove the entry in the same PR.
//
// The pure functions here (no IO) are unit-tested by the `dev-tools` vitest
// project. The thin IO + CLI driver lives in `check-touched-exemptions.mjs`.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const biomeConfigPath = resolve(repoRoot, 'biome.json');

export const SIZE_RULE_KEY = 'noExcessiveLinesPerFunction';
export const COMPLEXITY_RULE_KEY = 'noExcessiveCognitiveComplexity';

// Identify a debt-list `overrides` entry for a given rule key: blocks whose
// ONLY linter rule customization is `complexity.<ruleKey>: "off"`. Other
// overrides (e.g. the test-file block, which disables many rules) are
// general policy, not debt, and are intentionally excluded.
export function isExemptionOverrideFor(override, ruleKey) {
  const rules = override?.linter?.rules;
  if (!rules || typeof rules !== 'object') return false;
  const groups = Object.keys(rules);
  if (groups.length !== 1 || groups[0] !== 'complexity') return false;
  const complexity = rules.complexity;
  if (!complexity || typeof complexity !== 'object') return false;
  const ruleKeys = Object.keys(complexity);
  if (ruleKeys.length !== 1 || ruleKeys[0] !== ruleKey) return false;
  return complexity[ruleKey] === 'off';
}

// Parse a biome config object and return the deduped list of exempted globs
// for the given rule key (the union of `includes` from every matching
// debt-list override block).
export function extractExemptionGlobsFor(biomeConfig, ruleKey) {
  const overrides = Array.isArray(biomeConfig?.overrides) ? biomeConfig.overrides : [];
  const out = new Set();
  for (const override of overrides) {
    if (!isExemptionOverrideFor(override, ruleKey)) continue;
    const includes = Array.isArray(override.includes) ? override.includes : [];
    for (const glob of includes) {
      if (typeof glob === 'string' && glob.length > 0) out.add(glob);
    }
  }
  return [...out];
}

// Backward-compatible size-only wrappers, bound to the function-size rule key,
// preserving the original public surface for external/legacy callers and tests.
export function isSizeExemptionOverride(override) {
  return isExemptionOverrideFor(override, SIZE_RULE_KEY);
}

export function extractSizeExemptionGlobs(biomeConfig) {
  return extractExemptionGlobsFor(biomeConfig, SIZE_RULE_KEY);
}

// Set difference of two glob lists, returning the entries present in
// `currentGlobs` but not in `baseGlobs`. Order-preserving (in the order they
// appear in `currentGlobs`), deduped. Non-array inputs are treated as empty.
export function findAddedExemptions(baseGlobs, currentGlobs) {
  const current = Array.isArray(currentGlobs) ? currentGlobs : [];
  const base = Array.isArray(baseGlobs) ? baseGlobs : [];
  const baseSet = new Set(base);
  const seen = new Set();
  const out = [];
  for (const g of current) {
    if (typeof g !== 'string' || g.length === 0) continue;
    if (baseSet.has(g)) continue;
    if (seen.has(g)) continue;
    seen.add(g);
    out.push(g);
  }
  return out;
}

// Convert a biome-style include glob into an anchored RegExp.
// Supports `**` (zero or more path segments), `*` (chars except `/`), `?`.
// Other regex metacharacters are escaped literally.
export function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^$(){}|[]\\'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

export function matchesAnyGlob(filePath, globs) {
  return globs.some((g) => globToRegex(g).test(filePath));
}

// Given a list of PR-changed files and the debt globs, return the subset of
// changed files that are still on the debt list (the "boy-scout" violations).
export function findTouchedExemptions(changedFiles, exemptionGlobs) {
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) return [];
  if (!Array.isArray(exemptionGlobs) || exemptionGlobs.length === 0) return [];
  const regexes = exemptionGlobs.map(globToRegex);
  const out = [];
  for (const file of changedFiles) {
    if (regexes.some((r) => r.test(file))) out.push(file);
  }
  return out;
}

export function readBiomeConfig() {
  return JSON.parse(readFileSync(biomeConfigPath, 'utf-8'));
}
