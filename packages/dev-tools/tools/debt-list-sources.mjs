// Declarative registry of the repo's debt/exemption lists and the pure logic
// that decides whether a PR is allowed to grow them.
//
// A "debt list source" is a config file plus a way to read its exemption
// entries, plus the semantics the gate applies to it. The semantics differ per
// source ON PURPOSE — do not unify them into uniform harshness:
//
//   touched: true
//     Only for lists whose every entry is a file that CAN be fixed (the two
//     biome complexity debt lists). Touching such a file means paying its debt
//     down in the same PR. Applying this to a list that legitimately contains
//     permanent entries (generated files, `*.d.ts`, vendored code, fixtures)
//     would force pointless refactors on innocent PRs.
//   freeze: true + failOnGrowth: true
//     The list may not gain entries. Safe for every source here, including the
//     ones with permanent entries: existing entries stay, new ones need either
//     a real fix or a deliberate, reviewed config change.
//   freeze: true + failOnGrowth: false
//     Report growth, never fail. For lists where growth is routinely
//     legitimate and outside the author's control (knip's ignoreDependencies
//     grows with Renovate and with every new build tool).
//
// Every source carries the same bootstrapping exemption: entries whose scope
// has no entries at all in the base ref are ignored, because that scope (a
// whole list, or one package inside a per-package list) is being INTRODUCED by
// the PR under test rather than grown by it.
//
// The functions here are pure (no IO) and unit-tested by the `dev-tools`
// vitest project. The IO + CLI driver lives in `check-touched-exemptions.mjs`.

import { findAddedExemptions, findTouchedExemptions } from './size-exemption-lib.mjs';

// Separates an entry's scope from its value in the flattened entry strings the
// extractors emit. Config globs and package names never contain it.
export const SCOPE_DELIMITER = '::';

export function scopeOfEntry(entry) {
  if (typeof entry !== 'string') return '';
  const i = entry.indexOf(SCOPE_DELIMITER);
  return i === -1 ? '' : entry.slice(0, i);
}

export function scopedEntry(scope, value) {
  return scope ? `${scope}${SCOPE_DELIMITER}${value}` : value;
}

// Entries added vs the base ref, minus every entry whose scope is absent from
// the base (the bootstrapping exemption). Unscoped lists have the single scope
// '', so an empty base list exempts all of its entries.
export function findAddedEntries(baseEntries, currentEntries) {
  const added = findAddedExemptions(baseEntries, currentEntries);
  if (added.length === 0) return [];
  const base = Array.isArray(baseEntries) ? baseEntries : [];
  const baseScopes = new Set(base.filter((e) => typeof e === 'string').map(scopeOfEntry));
  return added.filter((entry) => baseScopes.has(scopeOfEntry(entry)));
}

function collectStrings(value) {
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string' && v.length > 0) : [];
}

function dedupe(entries) {
  return [...new Set(entries)];
}

// Biome `overrides` blocks that turn OFF rules outside the `complexity` group,
// or disable the linter wholesale. These are policy-shaped debt: unlike the two
// complexity debt lists they are not per-function-fixable, so they are frozen
// but never trigger the touched-file rule.
export function extractBiomeRuleDisablingGlobs(biomeConfig) {
  const overrides = Array.isArray(biomeConfig?.overrides) ? biomeConfig.overrides : [];
  const out = [];
  for (const override of overrides) {
    const linter = override?.linter;
    if (!linter || typeof linter !== 'object') continue;
    const rules = linter.rules;
    const disablesNonComplexityRule =
      !!rules &&
      typeof rules === 'object' &&
      Object.entries(rules).some(
        ([group, groupRules]) =>
          group !== 'complexity' &&
          !!groupRules &&
          typeof groupRules === 'object' &&
          Object.values(groupRules).some((level) => level === 'off')
      );
    if (linter.enabled !== false && !disablesNonComplexityRule) continue;
    out.push(...collectStrings(override.includes));
  }
  return dedupe(out);
}

// `coverageExclude` patterns from every group/package in coverage-thresholds.json.
// Walked generically so a new group (or package) needs no code change here.
// This list is the DENOMINATOR of the coverage floors the nightly ratchet
// raises: excluding a file makes the percentage go up while real coverage goes
// down, so an unfrozen list silently defeats the ratchet.
export function extractCoverageExcludeEntries(thresholds) {
  const out = [];
  for (const [group, groupValue] of Object.entries(thresholds ?? {})) {
    if (!groupValue || typeof groupValue !== 'object' || Array.isArray(groupValue)) continue;
    for (const [pkg, pkgValue] of Object.entries(groupValue)) {
      if (!pkgValue || typeof pkgValue !== 'object') continue;
      for (const pattern of collectStrings(pkgValue.coverageExclude)) {
        out.push(scopedEntry(`${group}.${pkg}`, pattern));
      }
    }
  }
  return dedupe(out);
}

export function extractJscpdIgnoreEntries(jscpdConfig) {
  return dedupe(collectStrings(jscpdConfig?.ignore));
}

const KNIP_IGNORE_KEYS = ['ignore', 'ignoreDependencies', 'ignoreBinaries', 'ignoreFiles'];

export function extractKnipIgnoreEntries(knipConfig) {
  const out = [];
  for (const key of KNIP_IGNORE_KEYS) {
    for (const value of collectStrings(knipConfig?.[key])) out.push(scopedEntry(key, value));
  }
  const workspaces = knipConfig?.workspaces;
  if (workspaces && typeof workspaces === 'object') {
    for (const [name, ws] of Object.entries(workspaces)) {
      if (!ws || typeof ws !== 'object') continue;
      for (const key of KNIP_IGNORE_KEYS) {
        for (const value of collectStrings(ws[key])) out.push(scopedEntry(`${name}.${key}`, value));
      }
    }
  }
  return dedupe(out);
}

export const DEBT_LIST_SOURCES = [
  {
    id: 'biome-rule-disabling',
    label: 'biome rule-disabling override',
    file: 'biome.json',
    location: 'biome.json `overrides` → non-complexity rules = off',
    extract: extractBiomeRuleDisablingGlobs,
    semantics: { touched: false, freeze: true, failOnGrowth: true },
    growthFixIt:
      'Fix: satisfy the rule in the new code instead of widening the override.\n' +
      'If the exemption is genuinely permanent (generated or vendored code), say so\n' +
      'in the PR body — a reviewer, not this gate, is the right approver.',
  },
  {
    id: 'coverage-exclude',
    label: 'coverage-exclude',
    file: 'coverage-thresholds.json',
    location: 'coverage-thresholds.json `coverageExclude`',
    extract: extractCoverageExcludeEntries,
    semantics: { touched: false, freeze: true, failOnGrowth: true },
    growthFixIt:
      'Fix: test the file instead of excluding it. `coverageExclude` is the\n' +
      'denominator of the floors the nightly ratchet raises, so a new exclusion\n' +
      'raises the reported percentage while real coverage falls.',
  },
  {
    id: 'duplication-ignore',
    label: 'duplication-ignore',
    file: 'jscpd.json',
    location: 'jscpd.json `ignore`',
    extract: extractJscpdIgnoreEntries,
    semantics: { touched: false, freeze: true, failOnGrowth: true },
    growthFixIt:
      'Fix: de-duplicate the code instead of hiding it from jscpd. An over-broad\n' +
      '`ignore` entry drops a whole app from the duplication signal.',
  },
  {
    id: 'knip-ignore',
    label: 'knip ignore',
    file: 'knip.json',
    location: 'knip.json `ignore` / `ignoreDependencies` / `ignoreBinaries`',
    extract: extractKnipIgnoreEntries,
    semantics: { touched: false, freeze: true, failOnGrowth: false },
    growthFixIt:
      'Note: new build tools and Renovate legitimately need entries here, so this\n' +
      'is reported and never fails. Keep the list honest anyway.',
  },
];

export function evaluateDebtSource(source, { currentEntries, baseEntries, baseAvailable }) {
  const current = Array.isArray(currentEntries) ? currentEntries : [];
  const skipReason = !source.semantics.freeze
    ? 'not frozen'
    : baseAvailable
      ? null
      : 'base config unreadable';
  const added = skipReason ? [] : findAddedEntries(baseEntries, current);
  return {
    source,
    added,
    skipReason,
    failed: added.length > 0 && source.semantics.failOnGrowth,
    warned: added.length > 0 && !source.semantics.failOnGrowth,
  };
}

// The two biome complexity debt lists keep the original per-rule semantics:
// frozen AND subject to the touched-file rule.
export function evaluateRuleDebtList(
  rule,
  { currentGlobs, baseGlobs, baseAvailable, changedFiles }
) {
  const globs = Array.isArray(currentGlobs) ? currentGlobs : [];
  const touched =
    rule.semantics?.touched === false ? [] : findTouchedExemptions(changedFiles, globs);
  const added = baseAvailable ? findAddedEntries(baseGlobs, globs) : [];
  return {
    source: rule,
    touched,
    added,
    skipReason: baseAvailable ? null : 'base config unreadable',
    failed: touched.length > 0 || added.length > 0,
    warned: false,
  };
}

export function formatTouchedReport(result) {
  const { source, touched } = result;
  const lines = [
    '',
    `The following changed files are still on the ${source.label} debt list`,
    `(${source.location}):`,
    '',
  ];
  for (const f of touched) lines.push(`  - ${f}  [${source.label}]`);
  lines.push('', source.touchedFixIt);
  return lines;
}

export function formatGrowthReport(result) {
  const { source, added, warned } = result;
  const verdict = warned
    ? `The ${source.label} list grew in this PR (reported, not enforced)`
    : `The ${source.label} debt list is frozen and must not grow; this PR adds new entries`;
  const lines = ['', verdict, `(${source.location}):`, ''];
  for (const entry of added) lines.push(`  + ${entry}  [${source.label}]`);
  lines.push('', source.growthFixIt);
  return lines;
}
