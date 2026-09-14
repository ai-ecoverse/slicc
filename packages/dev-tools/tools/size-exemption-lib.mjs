import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const biomeConfigPath = resolve(repoRoot, 'biome.json');

export const SIZE_RULE_KEY = 'noExcessiveLinesPerFunction';
export const COMPLEXITY_RULE_KEY = 'noExcessiveCognitiveComplexity';
export const FLOATING_PROMISE_RULE_KEY = 'noFloatingPromises';
export const MISUSED_PROMISE_RULE_KEY = 'noMisusedPromises';

export function isExemptionOverrideFor(override, ruleKey, ruleGroup = 'complexity') {
  const rules = override?.linter?.rules;
  if (!rules || typeof rules !== 'object') return false;
  const groups = Object.keys(rules);
  if (groups.length !== 1 || groups[0] !== ruleGroup) return false;
  const groupRules = rules[ruleGroup];
  if (!groupRules || typeof groupRules !== 'object') return false;
  const ruleKeys = Object.keys(groupRules);
  if (ruleKeys.length !== 1 || ruleKeys[0] !== ruleKey) return false;
  return groupRules[ruleKey] === 'off';
}

export function extractExemptionGlobsFor(biomeConfig, ruleKey, ruleGroup = 'complexity') {
  const overrides = Array.isArray(biomeConfig?.overrides) ? biomeConfig.overrides : [];
  const out = new Set();
  for (const override of overrides) {
    if (!isExemptionOverrideFor(override, ruleKey, ruleGroup)) continue;
    const includes = Array.isArray(override.includes) ? override.includes : [];
    for (const glob of includes) {
      if (typeof glob === 'string' && glob.length > 0) out.add(glob);
    }
  }
  return [...out];
}

export function isSizeExemptionOverride(override) {
  return isExemptionOverrideFor(override, SIZE_RULE_KEY);
}

export function extractSizeExemptionGlobs(biomeConfig) {
  return extractExemptionGlobsFor(biomeConfig, SIZE_RULE_KEY);
}

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
