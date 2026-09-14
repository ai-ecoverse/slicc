#!/usr/bin/env node

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

export const CONNECT_MODE_IDENTIFIER = '__slicc_connect_mode';

const PROBE_ONLY_MODULES = new Set([
  'shell/float-topology.js',
  'core/float-topology.js',
  'base/runtime-env.js',
  'core/runtime-env.js',
]);

const SHARED_TS_SPECIFIER = '@slicc/shared-ts';
const SHARED_TS_PROBE_NAMES = new Set(['isChromeExtensionRealm', 'canConnectToChromeRuntime']);

const BANNED_TOP_DIRS = new Set(['scoops', 'tools', 'kernel']);

const EXEMPT_FILES = new Set([
  'kernel/host.ts',
  'kernel/kernel-worker.ts',
  'kernel/port-bridge-client.ts',
]);

export function isBannedZoneFile(relPath) {
  return BANNED_TOP_DIRS.has(relPath.split('/')[0]) && !EXEMPT_FILES.has(relPath);
}

const BRACED_FROM_RE =
  /^[ \t]*(?:import|export)\s+(type\s+)?\{([^}]*)\}\s*from\s+['"]([^'"]+)['"]/gm;

const UNBRACED_FROM_RE =
  /^[ \t]*(?:import|export)\s+(?:type\s+)?(?:\*\s*(?:as\s+\w+\s+)?|\w+\s*)from\s+['"]([^'"]+)['"]/gm;

const BARE_IMPORT_RE = /^[ \t]*import\s+['"]([^'"]+)['"]/gm;

const DYNAMIC_IMPORT_RE = /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]/g;

function resolveSpecifier(importerDir, specifier) {
  return resolve('/', importerDir, specifier).slice(1);
}

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
    return;
  }
  if (clause === null || isTypeOnlyClause) return;
  const namesToCheck = specifier === SHARED_TS_SPECIFIER ? SHARED_TS_PROBE_NAMES : bannedNames;
  for (const name of namedBindingsOf(clause)) {
    if (namesToCheck.has(name)) hits.push({ line, what: name });
  }
}

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

const CONST_ALIAS_RE = new RegExp(
  `^[ \\t]*export\\s+const\\s+(\\w+)\\s*=\\s*(${NAME_ALTERNATION})\\s*;`,
  'gm'
);

const NAMED_ALIAS_RE = new RegExp(
  `^[ \\t]*export\\s+\\{[^}]*\\b(${NAME_ALTERNATION})\\s+as\\s+(\\w+)`,
  'gmd'
);

const FUNCTION_WRAPPER_RE = new RegExp(
  `^[ \\t]*export\\s+function\\s+(\\w+)\\s*\\([^)]*\\)\\s*(?::[^{]+)?\\{\\s*return\\s+(${NAME_ALTERNATION})\\s*\\([^)]*\\)\\s*;?\\s*\\}`,
  'gm'
);

const ARROW_WRAPPER_RE = new RegExp(
  `^[ \\t]*export\\s+const\\s+(\\w+)\\s*=\\s*(?:async\\s*)?\\([^)]*\\)\\s*(?::[^=]+?)?=>\\s*` +
    `(?:\\{\\s*return\\s+)?(${NAME_ALTERNATION})\\s*\\([^)]*\\)\\s*;?\\s*\\}?`,
  'gm'
);

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

function collect(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...collect(abs));
    else if (entry.isFile() && isWebappSource(entry.name)) out.push(abs);
  }
  return out;
}

export function scanAliasedProbeReExports() {
  const out = {};
  for (const abs of collect(SCAN_ROOT)) {
    const hits = findAliasedProbeReExports(readFileSync(abs, 'utf8'));
    if (hits.length > 0) out[relative(repoRoot, abs).split('\\').join('/')] = hits;
  }
  return out;
}

export function discoveredAliasNames(aliasScan) {
  const names = new Set();
  for (const hits of Object.values(aliasScan)) {
    for (const h of hits) names.add(h.to);
  }
  return [...names];
}

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

export function baselineFiles(baseline) {
  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) return [];
  return Object.keys(baseline).filter((k) => typeof k === 'string' && k.length > 0);
}

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
