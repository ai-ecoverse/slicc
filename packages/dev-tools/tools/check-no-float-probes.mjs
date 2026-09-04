#!/usr/bin/env node
/**
 * Float-probe ratchet (#2276 slice D): no NEW read of a float/topology probe
 * under `scoops/`, `tools/`, or `kernel/` — except `kernel/host.ts` and
 * `kernel/kernel-worker.ts`, the two composition roots where the float's
 * topology is resolved exactly once (see `docs/work-unit.md` Phase 6), and
 * `kernel/port-bridge-client.ts` (see its `EXEMPT_FILES` comment below).
 * Privileged float detection belongs on the injected `CapabilityBroker`
 * (`work-unit/capability/`) or, for a genuine transport decision, in
 * `shell/` (which owns topology — `shell/float-topology.ts`'s own header
 * says so) — never re-probed from business logic in the banned zone.
 * Review-patterns category 10 (`docs/review-patterns.md`) is the sibling
 * check for the general layer-stack shape this specializes.
 *
 * Round-1 review (Grok + human) on the first version of this gate planted a
 * batch of evasions that all passed silently — a gate that passes on a
 * planted violation is worse than no gate, so every one of them is now a
 * named regression test (`check-no-float-probes.test.mjs`). The design below
 * is shaped directly by what evaded the first cut:
 *
 *  1. NAME-based scanning alone is not enough. `shell/float-topology.ts`,
 *     `core/float-topology.ts`, `base/runtime-env.ts`, and
 *     `core/runtime-env.ts` (`PROBE_ONLY_MODULES`) exist for NOTHING but
 *     float detection — every export is a probe, a probe re-export, or a
 *     pure type describing one. Importing from one of them, in ANY form
 *     (named, default, namespace `import * as`, dynamic `import(…)`,
 *     `export * from`, type-only), is banned regardless of what NAME the
 *     importer binds it to — `import * as topo from '…/float-topology.js'`
 *     or `const { hasLocalNodeServer } = await import('…')` name the module,
 *     not a banned identifier, and a pure name scan cannot see either.
 *     `base/api-endpoint.ts` and `shell/proxied-fetch.ts` are the mixed
 *     case — they have real non-probe exports too (`resolveApiUrl`,
 *     `apiHeaders`, …) — so a named import of a probe identifier from them
 *     is a hit, but a namespace/default import is not (seeing one would
 *     need call-site analysis this scanner does not do). That named-clause
 *     check is not restricted to those two modules specifically: an alias
 *     `findAliasedProbeReExports` discovers can live in ANY file, so the
 *     name check runs against every relative import's clause, whichever
 *     module it names. `@slicc/shared-ts` is the one BARE-package case:
 *     only `isChromeExtensionRealm` / `canConnectToChromeRuntime` are
 *     banned, never the package, and no other bare specifier is scanned at
 *     all (an ordinary npm dependency must never false-positive just for
 *     sharing a binding name).
 *
 *  2. The banned-name list is not the same as "everything
 *     `resolveFloatTopology` reads". `getExtensionDelegateId` /
 *     `setExtensionDelegateId` (extension-delegate id) and the raw
 *     `__slicc_connect_mode` global property (connect-mode) are load-bearing
 *     topology FACTS with no less claim to the ban than the eight names
 *     slice A named — `kernel/port-bridge-client.ts` reads
 *     `getExtensionDelegateId()` today, unexempted, and slipped through the
 *     first cut because the name wasn't on the list at all.
 *     `__slicc_connect_mode` is a bag KEY, not an importable binding, so it
 *     is banned by a plain identifier scan (`CONNECT_MODE_IDENTIFIER`), not
 *     the import machinery above.
 *
 *  3. A whole-file / unanchored regex scan matches a STRING LITERAL that
 *     merely contains import-shaped text (`export const example = "import {
 *     hasLocalNodeServer } from '…'"`). Every static-import matcher below is
 *     anchored to its statement's own line start (`^[ \t]*`, `m` flag), so
 *     text appearing mid-line — inside a string, after `=`, anywhere that
 *     isn't the start of the statement itself — is structurally unreachable.
 *     Dynamic `import(…)` / `require(…)` are expression-level and cannot be
 *     anchored the same way; this mirrors `check-layer-back-edges.mjs`'s own
 *     un-anchored handling of that one shape and accepts the same residual,
 *     much narrower risk (a string that happens to contain a
 *     syntactically-exact `import('<relative-path>')` call).
 *
 * A discovery pass (`findAliasedProbeReExports`) still runs repo-wide and
 * feeds back into the banned-zone scan, now covering three shapes: a bare
 * value re-export (`export const isTrayExtension = getChromeExtensionRealm`),
 * a renamed named re-export (`export { getChromeExtensionRealm as x }` —
 * restricted to actual `export` clauses, not a plain import's local alias,
 * so `import { isExtensionRealm as inExt }` in an ALLOWED layer does not
 * globally poison the name `inExt`), and a wrapper that calls a probe in its
 * body (`export function inExtension() { return isExtensionRealm(); }` /
 * `export const inExtension = () => isExtensionRealm()`). The first two feed
 * a discovered NAME into the banned-zone name scan; the wrapper shape does
 * too, since it is consumed by name exactly like the alias shapes. A bare
 * value re-export or renamed re-export of a `PROBE_ONLY_MODULES` re-export
 * chain (`core/float-topology.ts` mirroring `shell/float-topology.ts` under
 * the SAME name) needs no special handling: the banned-zone scan already
 * catches that at the import site, since the literal name is unchanged.
 *
 * Baseline-ratcheted like `check-layer-back-edges.mjs`: `--update`
 * regenerates it, counts may only go down. It starts EMPTY — slices A–C's
 * migration work made that the honest starting point — and `--update`
 * refuses to WRITE a larger baseline than the one already on disk unless
 * `--allow-growth` is also passed, so a careless local `--update` cannot
 * silently grandfather a new violation before it is even committed.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { argv } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isWebappSource } from './check-layer-back-edges.mjs';
import { stripComments } from './check-no-ui-imports-in-providers.mjs';

const Filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(Filename, '..', '..', '..', '..');

const SCAN_ROOT = resolve(repoRoot, 'packages/webapp/src');
export const BASELINE_PATH = resolve(Filename, '..', 'float-probe-baseline.json');

/** The ten identifiers that answer "which float/topology am I on?" — #2276. */
export const FLOAT_PROBE_NAMES = [
  'isExtensionRealm',
  'isChromeExtensionRealm',
  'hasLocalNodeServer',
  'resolveFloatTopology',
  'getChromeExtensionRealm',
  'setChromeExtensionRealm',
  'hasChromeRuntimeConnect',
  'canConnectToChromeRuntime',
  'getExtensionDelegateId',
  'setExtensionDelegateId',
];

/**
 * The `__slicc_connect_mode` bag key `resolveFloatTopology` reads off
 * `globalThis` — a topology FACT, but not an importable binding, so it is
 * banned by a plain identifier scan rather than the import machinery below.
 */
export const CONNECT_MODE_IDENTIFIER = '__slicc_connect_mode';

/**
 * Modules whose entire surface is a float/topology probe (or a pure type
 * describing one). Importing from one, in ANY form, is banned in the zone —
 * see the module doc comment's point 1. Paths are `packages/webapp/src`-
 * relative, matching a resolved relative specifier's `.js` extension.
 */
const PROBE_ONLY_MODULES = new Set([
  'shell/float-topology.js',
  'core/float-topology.js',
  'base/runtime-env.js',
  'core/runtime-env.js',
]);

/** Bare package with two probe exports; the package itself is never banned. */
const SHARED_TS_SPECIFIER = '@slicc/shared-ts';
const SHARED_TS_PROBE_NAMES = new Set(['isChromeExtensionRealm', 'canConnectToChromeRuntime']);

/** Top-level `packages/webapp/src` directories where a float probe is banned. */
const BANNED_TOP_DIRS = new Set(['scoops', 'tools', 'kernel']);
/**
 * Files the ban exempts. `host.ts` and `kernel-worker.ts` are the two
 * composition roots that resolve topology exactly once at boot.
 * `port-bridge-client.ts` reads `getExtensionDelegateId()` per call as the
 * realm-aware Port/panel-RPC transport factory every kernel-side bridge
 * client shares (EXT7/EXT8) — the conceptually right home is `shell/`
 * (which owns topology), but it also imports the `PanelRpcOp` TYPE from
 * `kernel/panel-rpc.ts`, and moving it would turn that into a `shell/` →
 * `kernel/` dependency against the stack's intended direction; kept here
 * and named-exempted rather than force a back-edge to relocate it.
 */
const EXEMPT_FILES = new Set([
  'kernel/host.ts',
  'kernel/kernel-worker.ts',
  'kernel/port-bridge-client.ts',
]);

/** Whether a `packages/webapp/src`-relative path is in the banned zone. */
export function isBannedZoneFile(relPath) {
  return BANNED_TOP_DIRS.has(relPath.split('/')[0]) && !EXEMPT_FILES.has(relPath);
}

// Braced clauses (`import { … } from '…'`, `export { … } from '…'`),
// anchored to the statement's own line start so a string literal elsewhere
// on a DIFFERENT line is never matched. `[^}]*` spans newlines, so a
// Prettier-wrapped multi-line clause still matches from the line the
// statement itself starts on. `type\s+` covers a combined type-only import.
const BRACED_FROM_RE =
  /^[ \t]*(?:import|export)\s+(type\s+)?\{([^}]*)\}\s*from\s+['"]([^'"]+)['"]/gm;
// Unbraced forms: `import * as x from '…'`, `import x from '…'`,
// `export * from '…'`, `export * as ns from '…'`. Always single-line in
// practice, so no need to span newlines.
const UNBRACED_FROM_RE =
  /^[ \t]*(?:import|export)\s+(?:type\s+)?(?:\*\s*(?:as\s+\w+\s+)?|\w+\s*)from\s+['"]([^'"]+)['"]/gm;
// Bare side-effect import: `import '…';` (no clause, no `from`).
const BARE_IMPORT_RE = /^[ \t]*import\s+['"]([^'"]+)['"]/gm;
// Dynamic `import(…)` / `require(…)` — expression-level, cannot be
// statement-anchored; see the module doc comment's point 3 for the accepted
// residual risk this carries.
const DYNAMIC_IMPORT_RE = /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]/g;

/** Resolve a relative specifier against the importer's dir to a `src`-relative path. */
function resolveSpecifier(importerDir, specifier) {
  return resolve('/', importerDir, specifier).slice(1);
}

/**
 * Find every import (any form) of a `PROBE_ONLY_MODULES` path, or a named
 * import of a banned identifier (the ten `FLOAT_PROBE_NAMES` plus
 * `extraNames`) from anywhere else — `base/api-endpoint.ts` /
 * `shell/proxied-fetch.ts` (mixed-surface modules) and `@slicc/shared-ts`
 * (bare package, only its two probe exports) fall out of this generic
 * named-clause path naturally, and so does any module an alias happens to
 * live in — `findAliasedProbeReExports` discovers aliases repo-wide, not
 * just from a fixed module list, so the name check here cannot be
 * restricted to one either. `importerRel` resolves relative specifiers.
 * Comments are ignored. A `type`-only clause (the WHOLE import, `import
 * type { … }` — not a per-binding `type X` inside a mixed clause) is
 * skipped for the name check (inert at runtime) but NOT for a
 * `PROBE_ONLY_MODULES` path, which is banned regardless of clause shape —
 * see the module doc comment's point 1. Returns `[{ line, what }]`.
 */
export function findBannedZoneProbes(importerRel, source, extraNames = []) {
  const importerDir = importerRel.includes('/')
    ? importerRel.slice(0, importerRel.lastIndexOf('/'))
    : '.';
  const stripped = stripComments(source);
  const bannedNames = new Set([...FLOAT_PROBE_NAMES, ...extraNames]);
  const hits = [];

  const lineOf = (index) => stripped.slice(0, index).split('\n').length;

  BRACED_FROM_RE.lastIndex = 0;
  for (const m of stripped.matchAll(BRACED_FROM_RE)) {
    pushHitsForSpecifier({
      hits,
      line: lineOf(m.index),
      specifier: m[3],
      clause: m[2],
      isTypeOnlyClause: Boolean(m[1]),
      importerDir,
      bannedNames,
    });
  }
  for (const re of [UNBRACED_FROM_RE, BARE_IMPORT_RE]) {
    re.lastIndex = 0;
    for (const m of stripped.matchAll(re)) {
      pushHitsForSpecifier({
        hits,
        line: lineOf(m.index),
        specifier: m[1],
        clause: null,
        isTypeOnlyClause: false,
        importerDir,
        bannedNames,
      });
    }
  }
  DYNAMIC_IMPORT_RE.lastIndex = 0;
  for (const m of stripped.matchAll(DYNAMIC_IMPORT_RE)) {
    pushHitsForSpecifier({
      hits,
      line: lineOf(m.index),
      specifier: m[1],
      clause: null,
      isTypeOnlyClause: false,
      importerDir,
      bannedNames,
    });
  }

  // `__slicc_connect_mode`: a bag key, not an import — plain identifier scan.
  const connectModeRe = new RegExp(`\\b${CONNECT_MODE_IDENTIFIER}\\b`, 'g');
  for (const m of stripped.matchAll(connectModeRe)) {
    hits.push({ line: lineOf(m.index), what: CONNECT_MODE_IDENTIFIER });
  }

  return hits.sort((a, b) => a.line - b.line);
}

function pushHitsForSpecifier({
  hits,
  line,
  specifier,
  clause,
  isTypeOnlyClause,
  importerDir,
  bannedNames,
}) {
  if (specifier.startsWith('.')) {
    const resolved = resolveSpecifier(importerDir, specifier);
    if (PROBE_ONLY_MODULES.has(resolved)) {
      hits.push({ line, what: `import from '${specifier}'` });
      return;
    }
  } else if (specifier !== SHARED_TS_SPECIFIER) {
    // Any other bare package specifier: never scanned, so an ordinary npm
    // dependency cannot false-positive just for sharing a binding name.
    return;
  }
  if (clause === null || isTypeOnlyClause) return;
  const namesToCheck = specifier === SHARED_TS_SPECIFIER ? SHARED_TS_PROBE_NAMES : bannedNames;
  for (const name of namedBindingsOf(clause)) {
    if (namesToCheck.has(name)) hits.push({ line, what: name });
  }
}

/**
 * The original (pre-`as`) binding names in a `{ … }` clause, skipping a
 * per-binding `type X` inside a mixed clause (inert at runtime).
 */
function namedBindingsOf(clause) {
  const names = [];
  for (const rawSpecifier of clause.split(',')) {
    const specifier = rawSpecifier.trim();
    if (!specifier || specifier.startsWith('type ')) continue;
    names.push(specifier.split(/\s+as\s+/)[0].trim());
  }
  return names;
}

const NAME_ALTERNATION = FLOAT_PROBE_NAMES.join('|');
// `export const NEW = BANNED;` — a bare reference to the function value
// under a new name (not a call: `= BANNED()` stores a RESULT, which is the
// sanctioned composition-time-answer pattern, not a live probe re-export).
const CONST_ALIAS_RE = new RegExp(
  `^[ \\t]*export\\s+const\\s+(\\w+)\\s*=\\s*(${NAME_ALTERNATION})\\s*;`,
  'gm'
);
// `export { BANNED as NEW }` — a renamed re-export. Restricted to `export`
// clauses (not a plain `import { BANNED as local }`, whose local alias is
// confined to that one file and must not globally poison a common short name
// like `local` for every other file in the repo).
// `d` (hasIndices): the overall match starts at the clause's `export {`,
// which can be several lines above the actual `BANNED as NEW` pair inside a
// multi-line clause — `m.indices[1][0]` (capture group 1's own start) is
// used for the reported line instead of the match start, below.
const NAMED_ALIAS_RE = new RegExp(
  `^[ \\t]*export\\s+\\{[^}]*\\b(${NAME_ALTERNATION})\\s+as\\s+(\\w+)`,
  'gmd'
);
// `export function NEW(...) { return BANNED(...); }` — a THIN wrapper whose
// entire body is a pass-through return of the probe call (Grok's evasion:
// `export function inExtension() { return isExtensionRealm(); }`).
// Deliberately narrow, not "calls the probe anywhere in its body": a
// SUBSTANTIVE function that does real work and merely reads topology as one
// of several statements (`shell/tray-fetch.ts`'s `createTrayFetch`, already
// reviewed and approved in the network-domain slice) is not a probe-identity
// wrapper and must not become a globally-banned name just for importing it
// by its own real name (round-1 review, #2843: the wider "anywhere in the
// body" version flagged `createTrayFetch` itself).
const FUNCTION_WRAPPER_RE = new RegExp(
  `^[ \\t]*export\\s+function\\s+(\\w+)\\s*\\([^)]*\\)\\s*(?::[^{]+)?\\{\\s*return\\s+(${NAME_ALTERNATION})\\s*\\([^)]*\\)\\s*;?\\s*\\}`,
  'gm'
);
// The arrow-function form of the same THIN-wrapper shape — concise body
// (`=> BANNED(...)`) or a block body whose only statement is the same
// pass-through return.
const ARROW_WRAPPER_RE = new RegExp(
  `^[ \\t]*export\\s+const\\s+(\\w+)\\s*=\\s*(?:async\\s*)?\\([^)]*\\)\\s*(?::[^=]+?)?=>\\s*` +
    `(?:\\{\\s*return\\s+)?(${NAME_ALTERNATION})\\s*\\([^)]*\\)\\s*;?\\s*\\}?`,
  'gm'
);

/**
 * Find every re-export of a banned name under a genuinely different name in
 * `source` — a bare value re-export, a renamed named re-export, or a
 * function/arrow wrapper that calls the probe in its body. Returns `[{
 * line, from, to }]`. A same-name re-export (`export { hasLocalNodeServer }
 * from '…'`) is NOT a hit — `findBannedZoneProbes` already covers that
 * shape at the banned-zone import site, since the literal name is
 * unchanged.
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
  const lineOf = (index) => stripped.slice(0, index).split('\n').length;

  for (const m of stripped.matchAll(CONST_ALIAS_RE)) {
    if (m[1] === m[2]) continue;
    hits.push({ line: lineOf(m.index), from: m[2], to: m[1] });
  }
  for (const m of stripped.matchAll(NAMED_ALIAS_RE)) {
    if (m[1] === m[2] || FLOAT_PROBE_NAMES.includes(m[2])) continue;
    hits.push({ line: lineOf(m.indices[1][0]), from: m[1], to: m[2] });
  }
  for (const m of stripped.matchAll(FUNCTION_WRAPPER_RE)) {
    if (m[1] === m[2]) continue;
    hits.push({ line: lineOf(m.index), from: m[2], to: m[1] });
  }
  for (const m of stripped.matchAll(ARROW_WRAPPER_RE)) {
    if (m[1] === m[2]) continue;
    hits.push({ line: lineOf(m.index), from: m[2], to: m[1] });
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
 * files with hits. The scan folds in every discovered alias name (see
 * `discoveredAliasNames`), so a future rename of one of the banned names is
 * banned in the zone exactly like the original — it just does not error at
 * the (possibly legitimate, out-of-zone) file that defined the alias.
 */
export function scanBannedZoneProbes() {
  const extraNames = discoveredAliasNames(scanAliasedProbeReExports());
  const counts = {};
  for (const abs of collect(SCAN_ROOT)) {
    const srcRel = relative(SCAN_ROOT, abs).split('\\').join('/');
    if (!isBannedZoneFile(srcRel)) continue;
    const hits = findBannedZoneProbes(srcRel, readFileSync(abs, 'utf8'), extraNames);
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
    const existing = existsSync(BASELINE_PATH)
      ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
      : {};
    const growth = Object.entries(current).filter(([file, count]) => count > (existing[file] ?? 0));
    if (growth.length > 0 && !argv.includes('--allow-growth')) {
      for (const [file, count] of growth) {
        process.stderr.write(
          `::error::${file}: --update would grow the baseline to ${count} (was ` +
            `${existing[file] ?? 0}) — fix the violation, or pass --allow-growth to acknowledge ` +
            'it deliberately.\n'
        );
      }
      process.exit(1);
    }
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
      const srcRel = file.slice('packages/webapp/src/'.length);
      const hits = findBannedZoneProbes(
        srcRel,
        readFileSync(resolve(repoRoot, file), 'utf8'),
        extraNames
      );
      for (const h of hits) {
        process.stderr.write(`  ${file}:${h.line} '${h.what}'\n`);
      }
    }
    process.stderr.write(
      `\n${failures.length} float-probe violation(s). scoops/, tools/, and kernel/ (except ` +
        'the exempt composition roots) never ask "am I in the extension?" themselves — that ' +
        "answer is the injected CapabilityBroker's job, or a composition-time parameter (see " +
        'docs/work-unit.md Phase 6 and docs/review-patterns.md § Layer import direction).\n'
    );
    process.exit(1);
  }

  const total = Object.values(current).reduce((a, b) => a + b, 0);
  process.stdout.write(
    `ok: no new float-probe reads under scoops/, tools/, kernel/ (except the exempt ` +
      `composition roots) (${total} grandfathered in ${Object.keys(current).length} baselined files)\n`
  );
}

if (import.meta.url === pathToFileURL(argv[1] ?? '').href) main();
