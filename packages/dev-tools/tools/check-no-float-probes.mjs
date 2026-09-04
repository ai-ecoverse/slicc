#!/usr/bin/env node
/**
 * Float-probe ratchet (#2276 slice D): no NEW read of a float/topology probe
 * under `scoops/`, `tools/`, or `kernel/` — except `kernel/host.ts`, the one
 * composition root where the float's topology is resolved exactly once and
 * composed into a `CapabilityBroker` (see `docs/work-unit.md` Phase 6).
 * Privileged float detection belongs on that injected broker
 * (`work-unit/capability/`) or, for a genuine transport decision, in
 * `shell/` (which owns topology — `shell/float-topology.ts`'s own header
 * says so) — never re-probed from business logic in the banned zone.
 * Slices A–C (#2276) migrated every existing call site across the six
 * capability domains; this is the deterministic gate that keeps it migrated.
 * Review-patterns category 10 (`docs/review-patterns.md`) is the sibling
 * check for the general layer-stack shape this specializes.
 *
 * Two passes, folded into one scan (`scanBannedZoneProbes`):
 *
 *  1. `findBannedZoneProbes` — an IMPORT/RE-EXPORT-CLAUSE scan (`import {
 *     hasLocalNodeServer } from '…'`, `import { hasLocalNodeServer as x }
 *     from '…'`, `export { hasLocalNodeServer } from '…'`) for the eight
 *     banned identifiers, in every `scoops/` / `tools/` / `kernel/` file
 *     except `kernel/host.ts`. Deliberately NOT a whole-file identifier
 *     scan: every domain this ban applies to has ALREADY migrated to the
 *     sanctioned composition-time-answer idiom, which reuses the SAME
 *     identifier name for a local const / parameter / property
 *     (`shell-and-skills.ts`'s `const hasLocalNodeServer = () =>
 *     localNode.ok`, `telemetry.ts`'s `getModeLabel(isExtensionRealm:
 *     boolean)`) precisely so call sites read the same either way. A
 *     whole-file scan cannot tell that reuse apart from an actual probe
 *     import and false-positives on every migrated file; scanning import
 *     clauses only catches the one thing that is actually banned — PULLING
 *     THE BINDING IN FROM ITS DEFINING MODULE — which a local name can never
 *     do by construction.
 *
 *  2. `findAliasedProbeReExports` / `discoveredAliasNames` — a repo-wide
 *     scan (every `webapp/src` file) for a re-export of one of the eight
 *     names under a genuinely DIFFERENT name — `export const
 *     isTrayExtension = getChromeExtensionRealm` or `export {
 *     getChromeExtensionRealm as x }` — which would let a banned-zone file
 *     import the alias and slip past pass 1 without ever matching a literal
 *     banned name. Every discovered alias is folded INTO pass 1's name
 *     pattern before it runs, so the violation surfaces at the banned-zone
 *     IMPORT site (if one ever appears), not at the file that defined the
 *     alias — `core/secret-topology.ts`'s long-standing, well-documented
 *     `resolveFloatTopology as resolveSecretTopology` (consumed only by
 *     `core/` / `providers/` / `transcript/` today, unrelated to #2276) is
 *     not itself a violation, but a future `scoops/` import of
 *     `resolveSecretTopology` would be, exactly like importing
 *     `resolveFloatTopology` directly. This is necessarily narrower than
 *     full dataflow analysis: it does not follow a rename through an
 *     intermediate wrapper FUNCTION that calls the probe internally — a
 *     wrapper like that still names the probe in its own body, which pass 1
 *     catches wherever the wrapper itself lives. Legitimate same-name
 *     re-exports (`core/float-topology.ts` mirroring
 *     `shell/float-topology.ts`) need no special handling: pass 1 already
 *     catches those at the banned-zone import site, since the literal name
 *     is unchanged.
 *
 * Baseline-ratcheted like `check-layer-back-edges.mjs`: `--update`
 * regenerates it, counts may only go down. It starts EMPTY — slices A–C's
 * migration work made that the honest starting point; a new banned-zone
 * probe read must fix the layering, never grow the baseline.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { argv } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isWebappSource } from './check-layer-back-edges.mjs';
import { stripComments } from './check-no-ui-imports-in-providers.mjs';

const Filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(Filename, '..', '..', '..', '..');

const SCAN_ROOT = resolve(repoRoot, 'packages/webapp/src');
export const BASELINE_PATH = resolve(Filename, '..', 'float-probe-baseline.json');

/** The eight names that answer "which float/topology am I on?" — #2276. */
export const FLOAT_PROBE_NAMES = [
  'isExtensionRealm',
  'isChromeExtensionRealm',
  'hasLocalNodeServer',
  'resolveFloatTopology',
  'getChromeExtensionRealm',
  'setChromeExtensionRealm',
  'hasChromeRuntimeConnect',
  'canConnectToChromeRuntime',
];

/** Top-level `packages/webapp/src` directories where a float probe is banned. */
const BANNED_TOP_DIRS = new Set(['scoops', 'tools', 'kernel']);
/** The one file the ban exempts: the composition root that resolves topology once. */
const EXEMPT_FILES = new Set(['kernel/host.ts']);

/** Whether a `packages/webapp/src`-relative path is in the banned zone. */
export function isBannedZoneFile(relPath) {
  return BANNED_TOP_DIRS.has(relPath.split('/')[0]) && !EXEMPT_FILES.has(relPath);
}

/** Build a `\b(?:name|name|…)\b` pattern over the eight names plus any discovered aliases. */
export function buildProbeNamePattern(extraNames = []) {
  const all = [...FLOAT_PROBE_NAMES, ...extraNames];
  return new RegExp(`\\b(?:${all.join('|')})\\b`, 'g');
}

// `import { … } from '…'` / `export { … } from '…'` — named-binding clauses,
// the only shape that actually pulls a probe's ORIGINAL binding into scope
// (or re-exports it under its own name). `type\s+` handles a `type`-only
// combined specifier (`import { type X, Y }`); the clause body is split on
// commas below to check each binding's pre-`as` (original) name.
const NAMED_CLAUSE_RE = /(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s*from\s+['"][^'"]+['"]/g;

/**
 * Find every import/re-export of a banned name (or discovered alias, see
 * `extraNames`) in `source`. Comments are ignored. Returns `[{ line, name
 * }]`. Deliberately narrower than a whole-file scan — see the module doc
 * comment for why: it does not see a dynamic `import(...)` followed by
 * property access, or a namespace import (`import * as x`) followed by
 * `x.hasLocalNodeServer` — neither shape is used anywhere in this codebase
 * for these names today.
 */
export function findBannedZoneProbes(source, extraNames = []) {
  const stripped = stripComments(source);
  const banned = new Set([...FLOAT_PROBE_NAMES, ...extraNames]);
  const hits = [];
  for (const m of stripped.matchAll(NAMED_CLAUSE_RE)) {
    const line = stripped.slice(0, m.index).split('\n').length;
    for (const rawSpecifier of m[1].split(',')) {
      const specifier = rawSpecifier.trim().replace(/^type\s+/, '');
      if (!specifier) continue;
      const originalName = specifier.split(/\s+as\s+/)[0].trim();
      if (banned.has(originalName)) hits.push({ line, name: originalName });
    }
  }
  return hits;
}

const NAME_ALTERNATION = FLOAT_PROBE_NAMES.join('|');
// `export const NEW = BANNED;` — a bare reference to the function value
// under a new name (not a call: `= BANNED()` stores a RESULT, which is the
// sanctioned composition-time-answer pattern, not a live probe re-export).
const CONST_ALIAS_RE = new RegExp(
  `export\\s+const\\s+(\\w+)\\s*=\\s*(${NAME_ALTERNATION})\\s*;`,
  'g'
);
// `export { BANNED as NEW }` (optionally `from '...'`) — a renamed re-export.
const NAMED_ALIAS_RE = new RegExp(`\\b(${NAME_ALTERNATION})\\s+as\\s+(\\w+)`, 'g');

/**
 * Find every re-export of a banned name under a genuinely different name in
 * `source`. Returns `[{ line, from, to }]`. A same-name re-export (`export {
 * hasLocalNodeServer } from '...'`) is NOT a hit — `findBannedZoneProbes`
 * already covers that shape at the banned-zone import site, since the
 * literal name is unchanged.
 *
 * A rename OUTSIDE the banned zone (like `core/secret-topology.ts`'s
 * long-standing `resolveFloatTopology as resolveSecretTopology`, unrelated
 * to #2276 and consumed only by `core/` / `providers/` / `transcript/`
 * call sites today) is not an error by itself — see `scanBannedZoneProbes`,
 * which folds every discovered alias name into its own scan instead, so the
 * violation surfaces at the banned-zone import site if one ever appears,
 * not at the (legitimate) file that defined the alias.
 */
export function findAliasedProbeReExports(source) {
  const stripped = stripComments(source);
  const hits = [];
  for (const m of stripped.matchAll(CONST_ALIAS_RE)) {
    if (m[1] === m[2]) continue;
    const line = stripped.slice(0, m.index).split('\n').length;
    hits.push({ line, from: m[2], to: m[1] });
  }
  for (const m of stripped.matchAll(NAMED_ALIAS_RE)) {
    if (m[1] === m[2] || FLOAT_PROBE_NAMES.includes(m[2])) continue;
    const line = stripped.slice(0, m.index).split('\n').length;
    hits.push({ line, from: m[1], to: m[2] });
  }
  return hits.sort((a, b) => a.line - b.line);
}

/** Recursively collect webapp source files under `dir`. */
function collect(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...collect(abs));
    else if (entry.isFile() && isWebappSource(entry.name)) out.push(abs);
  }
  return out;
}

/** Scan the whole tree; returns `{ 'packages/webapp/src/...': [hit] }` for aliasing files. */
export function scanAliasedProbeReExports() {
  const out = {};
  for (const abs of collect(SCAN_ROOT)) {
    const hits = findAliasedProbeReExports(readFileSync(abs, 'utf8'));
    if (hits.length > 0) out[relative(repoRoot, abs).split('\\').join('/')] = hits;
  }
  return out;
}

/** Every discovered alias name, repo-wide (see `scanAliasedProbeReExports`). */
export function discoveredAliasNames(aliasScan) {
  const names = new Set();
  for (const hits of Object.values(aliasScan)) {
    for (const h of hits) names.add(h.to);
  }
  return [...names];
}

/**
 * Scan the banned zone; returns `{ 'packages/webapp/src/...': count }` for
 * files with hits. The scan pattern includes every discovered alias name
 * (see `discoveredAliasNames`), so a future rename of one of the eight names
 * is banned in the zone exactly like the original — it just does not error
 * at the (possibly legitimate, out-of-zone) file that defined the alias.
 */
export function scanBannedZoneProbes() {
  const extraNames = discoveredAliasNames(scanAliasedProbeReExports());
  const counts = {};
  for (const abs of collect(SCAN_ROOT)) {
    const srcRel = relative(SCAN_ROOT, abs).split('\\').join('/');
    if (!isBannedZoneFile(srcRel)) continue;
    const hits = findBannedZoneProbes(readFileSync(abs, 'utf8'), extraNames);
    if (hits.length > 0) counts[relative(repoRoot, abs).split('\\').join('/')] = hits.length;
  }
  return counts;
}

/**
 * File paths listed in a parsed baseline object (its keys). Used by the
 * boy-scout gate (`check-touched-exemptions.mjs`) to treat the baseline as a
 * debt list, mirroring `check-layer-back-edges.mjs`'s `baselineFiles`.
 */
export function baselineFiles(baseline) {
  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) return [];
  return Object.keys(baseline).filter((k) => typeof k === 'string' && k.length > 0);
}

/** Compare `current` counts against `baseline`. Returns failure messages, [] when clean. */
export function compareToBaseline(current, baseline) {
  const failures = [];
  for (const [file, count] of Object.entries(current)) {
    const allowed = baseline[file] ?? 0;
    if (count > allowed) {
      failures.push(
        `${file}: ${count} float-probe read(s), baseline allows ${allowed} — ask the injected ` +
          'CapabilityBroker or take a composition-time answer instead of re-probing the float.'
      );
    } else if (count < allowed) {
      failures.push(
        `${file}: ${count} float-probe read(s), baseline says ${allowed} — thanks for paying ` +
          'debt down! Ratchet the baseline: node packages/dev-tools/tools/check-no-float-probes.mjs --update'
      );
    }
  }
  for (const file of Object.keys(baseline)) {
    if (!(file in current)) {
      failures.push(
        `${file}: baseline entry is stale (file clean or gone) — run ` +
          'node packages/dev-tools/tools/check-no-float-probes.mjs --update'
      );
    }
  }
  return failures;
}

function sortedCounts(counts) {
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function main() {
  const current = scanBannedZoneProbes();

  if (argv.includes('--update')) {
    writeFileSync(BASELINE_PATH, `${JSON.stringify(sortedCounts(current), null, 2)}\n`);
    const total = Object.values(current).reduce((a, b) => a + b, 0);
    process.stdout.write(
      `baseline updated: ${total} grandfathered float-probe read(s) in ${Object.keys(current).length} file(s)\n`
    );
    return;
  }

  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  const failures = compareToBaseline(current, baseline);

  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`::error::${failure}\n`);
    const extraNames = discoveredAliasNames(scanAliasedProbeReExports());
    for (const [file, count] of Object.entries(current)) {
      if (count <= (baseline[file] ?? 0)) continue;
      const hits = findBannedZoneProbes(readFileSync(resolve(repoRoot, file), 'utf8'), extraNames);
      for (const h of hits) {
        process.stderr.write(`  ${file}:${h.line} '${h.name}'\n`);
      }
    }
    process.stderr.write(
      `\n${failures.length} float-probe violation(s). scoops/, tools/, and kernel/ (except ` +
        'kernel/host.ts) never ask "am I in the extension?" themselves — that answer is the ' +
        "injected CapabilityBroker's job, or a composition-time parameter (see " +
        'docs/work-unit.md Phase 6 and docs/review-patterns.md § Layer import direction).\n'
    );
    process.exit(1);
  }

  const total = Object.values(current).reduce((a, b) => a + b, 0);
  process.stdout.write(
    `ok: no new float-probe reads under scoops/, tools/, kernel/ (except kernel/host.ts) ` +
      `(${total} grandfathered in ${Object.keys(current).length} baselined files)\n`
  );
}

if (import.meta.url === pathToFileURL(argv[1] ?? '').href) main();
