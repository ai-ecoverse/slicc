#!/usr/bin/env node

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { argv } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripComments } from './check-no-ui-imports-in-providers.mjs';

const Filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(Filename), '..', '..', '..');

const SCAN_ROOT = resolve(repoRoot, 'packages/webapp/src');
export const BASELINE_PATH = resolve(dirname(Filename), 'layer-back-edge-baseline.json');

export const LAYER_RANK = {
  base: 0,
  fs: 0,
  shell: 1,
  git: 1,
  cdp: 2,
  tools: 3,
  core: 4,
  scoops: 5,
  ui: 6,
};

const UNRANKED_IMPORTER_RANK = LAYER_RANK.ui - 0.5;

export function isWebappSource(name) {
  return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name);
}

function isPackageSource(name) {
  return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts');
}

export function layerOf(relPath) {
  return relPath.split('/')[0];
}

const NODE_SERVER_ENTRY = new Set([
  'index.ts',
  'electron-main.ts',
  'publish-chrome-web-store-main.ts',
  'release-package-main.ts',
]);
const NODE_SERVER_TRANSPORT = new Set([
  'bridge-security.ts',
  'fetch-proxy-gzip.ts',
  'http-keepalive.ts',
  'links-middleware.ts',
  'runtime-flags.ts',
  'cli-log-dedup.ts',
]);

export function nodeServerLayerOf(relPath) {
  const srcRel = toSourcePath(relPath);
  const top = srcRel.split('/')[0];
  if (NODE_SERVER_ENTRY.has(srcRel)) return 'entry';
  if (top === 'cdp-proxy' || NODE_SERVER_TRANSPORT.has(srcRel)) return 'transport';
  return 'services';
}

const CHROME_EXT_SHARED = new Set([
  'sidepanel-entry.ts',
  'secrets-entry.ts',
  'secrets-storage.ts',
  'cherry-panel-protocol.ts',
  'fetch-proxy-shared.ts',
  'oauth-flow-options.ts',
  'discovery-observer.ts',
]);

export function chromeExtensionLayerOf(relPath) {
  const name = toSourcePath(relPath).split('/').pop();
  if (name === 'service-worker.ts') return 'entry';
  if (CHROME_EXT_SHARED.has(name)) return 'shared';
  return 'sw';
}

const WORKER_SHARED_FILES = new Set([
  'shared.ts',
  'links.ts',
  'timing-safe-equal.ts',
  'webhook-body.ts',
  'apns.ts',
  'apns-provider-token.ts',
  'oauth-registry.ts',
  'persistent-preview-storage.ts',
  'preview-cache.ts',
  'preview-host.ts',
  'preview-continuity.ts',
  'preview-bridge-assets.ts',
  'turn-credentials.ts',
  'flags.ts',
]);

export function cloudflareWorkerLayerOf(relPath) {
  const srcRel = toSourcePath(relPath);

  if (srcRel === 'index.ts' || srcRel === 'preview-worker.ts') return 'entry';
  if (WORKER_SHARED_FILES.has(srcRel) || srcRel.startsWith('auth/')) return 'shared';

  if (srcRel.startsWith('session-tray-')) return 'shared';
  if (srcRel.startsWith('cloud/')) {
    if (
      srcRel === 'cloud/handlers.ts' ||
      srcRel === 'cloud/cloud-sessions-do.ts' ||
      srcRel.startsWith('cloud/handler')
    ) {
      return 'routes';
    }
    return 'shared';
  }
  return 'routes';
}

function stripJsTsExt(relPath) {
  return relPath.replace(/\.[cm]?[jt]sx?$/, '');
}

function toSourcePath(relPath) {
  return relPath
    .replace(/\.jsx$/, '.tsx')
    .replace(/\.mjs$/, '.mts')
    .replace(/\.cjs$/, '.cts')
    .replace(/\.js$/, '.ts');
}

export const LAYER_STACKS = [
  {
    id: 'webapp',
    scanRoot: SCAN_ROOT,
    baselinePath: BASELINE_PATH,
    layerRank: LAYER_RANK,
    layerOf,
    unrankedImporterRank: UNRANKED_IMPORTER_RANK,
    isolatedLayers: new Set(),
    stackLabel: 'fs → shell/git → cdp → tools → core → scoops → ui',
    accept: isWebappSource,
  },
  {
    id: 'node-server',
    scanRoot: resolve(repoRoot, 'packages/node-server/src'),
    baselinePath: resolve(dirname(Filename), 'layer-back-edge-baseline-node-server.json'),
    layerRank: { transport: 0, services: 1, entry: 2 },
    layerOf: nodeServerLayerOf,
    unrankedImporterRank: 0,
    isolatedLayers: new Set(),
    stackLabel: 'transport → services → entry',
    accept: isPackageSource,
  },
  {
    id: 'chrome-extension',
    scanRoot: resolve(repoRoot, 'packages/chrome-extension/src'),
    baselinePath: resolve(dirname(Filename), 'layer-back-edge-baseline-chrome-extension.json'),
    layerRank: { shared: 0, sw: 1, entry: 2 },
    layerOf: chromeExtensionLayerOf,
    unrankedImporterRank: 0,
    isolatedLayers: new Set(),
    stackLabel: 'shared/page → sw → entry',
    accept: isPackageSource,
  },
  {
    id: 'cloudflare-worker',
    scanRoot: resolve(repoRoot, 'packages/cloudflare-worker/src'),
    baselinePath: resolve(dirname(Filename), 'layer-back-edge-baseline-cloudflare-worker.json'),
    layerRank: { shared: 0, routes: 1, entry: 2 },
    layerOf: cloudflareWorkerLayerOf,
    unrankedImporterRank: 0,
    isolatedLayers: new Set(['routes']),
    stackLabel: 'shared/links/auth → routes → entry',
    accept: (name) => isPackageSource(name) && name !== 'preview-bridge-assets.ts',
  },
];

const WEBAPP_STACK = LAYER_STACKS[0];

export function stackById(id) {
  return LAYER_STACKS.find((s) => s.id === id);
}

const RELATIVE_IMPORT_RE =
  /(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)['"](\.\.?\/[^'"]+)['"]/g;

const TYPE_ONLY_NAMED_CLAUSE_RE = /import\s+type\s*\{[^}]*\}\s*from\s*['"](\.\.?\/[^'"]+)['"]/g;

function typeOnlyFromKeywordIndex(match) {
  const brace = match[0].lastIndexOf('}');
  if (brace < 0) return -1;
  const kw = /\bfrom\s*['"]/.exec(match[0].slice(brace));
  return kw ? match.index + brace + kw.index : -1;
}

function kernelSegmentFollowsInterpolation(raw) {
  const parts = raw.split('?')[0].split('/');
  let seenInterp = false;
  for (const part of parts) {
    if (part.includes('${')) seenInterp = true;
    else if (part === 'kernel' && seenInterp) return true;
  }
  return false;
}

export function findLayerBackEdges(importerRel, source, stack = WEBAPP_STACK) {
  const fromLayer = stack.layerOf(importerRel);
  const fromRank = stack.layerRank[fromLayer] ?? stack.unrankedImporterRank;
  const importerDir = dirname(importerRel);
  const hits = [];
  const stripped = stripComments(source);
  const isolated = stack.isolatedLayers;
  const typeOnlyFromIndices = new Set();
  if (stack.id === 'webapp' && fromLayer === 'scoops') {
    for (const tm of stripped.matchAll(TYPE_ONLY_NAMED_CLAUSE_RE)) {
      const idx = typeOnlyFromKeywordIndex(tm);
      if (idx >= 0) typeOnlyFromIndices.add(idx);
    }
  }

  const consider = (specifier, matchIndex, resolvedTarget) => {
    const queryAt = specifier.indexOf('?');
    const target =
      resolvedTarget ??
      resolve('/', importerDir, queryAt >= 0 ? specifier.slice(0, queryAt) : specifier).slice(1);
    const toLayer = stack.layerOf(target);
    const toRank = stack.layerRank[toLayer];
    const scoopsKernelValue =
      stack.id === 'webapp' &&
      fromLayer === 'scoops' &&
      toLayer === 'kernel' &&
      !typeOnlyFromIndices.has(matchIndex);
    if (toRank === undefined && !scoopsKernelValue) return;
    const up = scoopsKernelValue || (toRank !== undefined && toRank > fromRank);
    const sideways =
      isolated.has(fromLayer) &&
      fromLayer === toLayer &&
      stripJsTsExt(target) !== stripJsTsExt(importerRel);
    if (!up && !sideways) return;
    const line = stripped.slice(0, matchIndex).split('\n').length;
    hits.push({ line, specifier, from: fromLayer, to: toLayer });
  };

  for (const m of stripped.matchAll(RELATIVE_IMPORT_RE)) {
    consider(m[1], m.index);
  }
  for (const m of stripped.matchAll(BACKTICK_IMPORT_RE)) {
    const raw = m[1];
    if (raw.includes('${')) {
      if (
        stack.id === 'webapp' &&
        fromLayer === 'scoops' &&
        kernelSegmentFollowsInterpolation(raw)
      ) {
        consider(raw, m.index, 'kernel/__interp__.js');
        continue;
      }
      const staticish = raw.replace(/\$\{[^}]*\}/g, '__interp__');
      const queryAt = staticish.indexOf('?');
      const target = resolve(
        '/',
        importerDir,
        queryAt >= 0 ? staticish.slice(0, queryAt) : staticish
      ).slice(1);
      consider(raw, m.index, target);
      continue;
    }
    consider(raw, m.index);
  }
  return hits;
}

const INERT_ASSET_QUERIES = new Set(['raw', 'url']);

export function findCrossPackageEscapes(importerRel, source) {
  const importerDir = dirname(importerRel);
  const hits = [];
  const stripped = stripComments(source);
  for (const m of stripped.matchAll(RELATIVE_IMPORT_RE)) {
    const specifier = m[1];
    const queryAt = specifier.indexOf('?');
    if (queryAt >= 0 && INERT_ASSET_QUERIES.has(specifier.slice(queryAt + 1))) continue;
    const abs = resolve(
      SCAN_ROOT,
      importerDir,
      queryAt >= 0 ? specifier.slice(0, queryAt) : specifier
    );
    if (!relative(SCAN_ROOT, abs).startsWith('..')) continue;
    const line = stripped.slice(0, m.index).split('\n').length;
    hits.push({ line, specifier, to: relative(repoRoot, abs).split('\\').join('/') });
  }
  return hits;
}

export function baselineFiles(baseline) {
  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) return [];
  return Object.keys(baseline).filter((k) => typeof k === 'string' && k.length > 0);
}

function collect(dir, accept = isWebappSource) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...collect(abs, accept));
    else if (entry.isFile() && accept(entry.name)) out.push(abs);
  }
  return out;
}

export function scanStackBackEdges(stack) {
  const counts = {};
  for (const abs of collect(stack.scanRoot, stack.accept)) {
    const srcRel = relative(stack.scanRoot, abs).split('\\').join('/');
    const hits = findLayerBackEdges(srcRel, readFileSync(abs, 'utf8'), stack);
    if (hits.length > 0) counts[relative(repoRoot, abs).split('\\').join('/')] = hits.length;
  }
  return counts;
}

export function scanBackEdges() {
  return scanStackBackEdges(WEBAPP_STACK);
}

export function scanCrossPackageEscapes() {
  const escapes = {};
  for (const abs of collect(SCAN_ROOT)) {
    const srcRel = relative(SCAN_ROOT, abs).split('\\').join('/');
    const hits = findCrossPackageEscapes(srcRel, readFileSync(abs, 'utf8'));
    if (hits.length > 0) escapes[relative(repoRoot, abs).split('\\').join('/')] = hits;
  }
  return escapes;
}

const CHROME_EXT_PKG = resolve(repoRoot, 'packages/chrome-extension');
const CHROME_EXT_SCAN_DIRS = [resolve(CHROME_EXT_PKG, 'src'), resolve(CHROME_EXT_PKG, 'tests')];
const WEBCOMPONENTS_PKG = resolve(repoRoot, 'packages/webcomponents');
const WEBCOMPONENTS_SCAN_DIRS = [
  resolve(WEBCOMPONENTS_PKG, 'src'),
  resolve(WEBCOMPONENTS_PKG, 'tests'),
];

const ALLOWED_TYPE_ONLY_WEBAPP_TARGET = 'packages/webapp/src/kernel/messages.js';

const BACKTICK_IMPORT_RE = /(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)`([^`]*)`/g;

const CONCAT_CALL_ARGS_RE =
  /(?:import|require)\s*\(\s*((?:['"][^'"]*['"]\s*\+\s*)+['"][^'"]*['"])\s*\)/g;
const QUOTED_SEGMENT_RE = /['"]([^'"]*)['"]/g;

const TRIPLE_SLASH_REFERENCE_RE = /\/\/\/\s*<reference\s+path=["']([^"']+)["']\s*\/>/g;

function resolveWebappTarget(scanRoot, importerDir, specifier) {
  const queryAt = specifier.indexOf('?');
  const abs = resolve(
    scanRoot,
    importerDir,
    queryAt >= 0 ? specifier.slice(0, queryAt) : specifier
  );
  const targetRel = relative(repoRoot, abs).split('\\').join('/');
  return targetRel.startsWith('packages/webapp/src/') ? targetRel : null;
}

function findWebappEscapes(scanRoot, importerRel, source, options = {}) {
  const allowTypeOnlyKernelMessages = options.allowTypeOnlyKernelMessages === true;
  const importerDir = dirname(importerRel);

  const hits = [];
  for (const m of source.matchAll(TRIPLE_SLASH_REFERENCE_RE)) {
    const to = resolveWebappTarget(scanRoot, importerDir, m[1]);
    if (to === null) continue;
    const line = source.slice(0, m.index).split('\n').length;
    hits.push({ line, specifier: m[1], to });
  }

  const stripped = stripComments(source);

  const typeOnlyFromIndices = new Map();
  if (allowTypeOnlyKernelMessages) {
    for (const m of stripped.matchAll(TYPE_ONLY_NAMED_CLAUSE_RE)) {
      const list = typeOnlyFromIndices.get(m[1]) ?? [];
      list.push(typeOnlyFromKeywordIndex(m));
      typeOnlyFromIndices.set(m[1], list);
    }
  }

  for (const m of stripped.matchAll(RELATIVE_IMPORT_RE)) {
    const specifier = m[1];
    const targetRel = resolveWebappTarget(scanRoot, importerDir, specifier);
    if (targetRel === null) continue;

    const isTypeOnlyOccurrence = (typeOnlyFromIndices.get(specifier) ?? []).includes(m.index);
    if (isTypeOnlyOccurrence && targetRel === ALLOWED_TYPE_ONLY_WEBAPP_TARGET) continue;

    const line = stripped.slice(0, m.index).split('\n').length;
    hits.push({ line, specifier, to: targetRel });
  }

  for (const m of stripped.matchAll(BACKTICK_IMPORT_RE)) {
    const raw = m[1];
    const line = stripped.slice(0, m.index).split('\n').length;
    if (!raw.includes('${')) {
      const targetRel = resolveWebappTarget(scanRoot, importerDir, raw);
      if (targetRel !== null) hits.push({ line, specifier: raw, to: targetRel });
      continue;
    }

    if (raw.includes('webapp/src')) {
      hits.push({ line, specifier: raw, to: 'packages/webapp/src/ (interpolated, unresolved)' });
    }
  }

  for (const m of stripped.matchAll(CONCAT_CALL_ARGS_RE)) {
    const segments = [...m[1].matchAll(QUOTED_SEGMENT_RE)].map((seg) => seg[1]);
    const joined = segments.join('');
    const targetRel = resolveWebappTarget(scanRoot, importerDir, joined);
    if (targetRel === null) continue;
    const line = stripped.slice(0, m.index).split('\n').length;
    hits.push({ line, specifier: joined, to: targetRel });
  }

  return hits;
}

export function findChromeExtensionWebappEscapes(importerRel, source) {
  return findWebappEscapes(CHROME_EXT_PKG, importerRel, source, {
    allowTypeOnlyKernelMessages: true,
  });
}

export function findWebcomponentsWebappEscapes(importerRel, source) {
  return findWebappEscapes(WEBCOMPONENTS_PKG, importerRel, source);
}

export function scanChromeExtensionWebappEscapes() {
  const escapes = {};
  for (const dir of CHROME_EXT_SCAN_DIRS) {
    for (const abs of collectTs(dir)) {
      const pkgRel = relative(CHROME_EXT_PKG, abs).split('\\').join('/');
      const hits = findChromeExtensionWebappEscapes(pkgRel, readFileSync(abs, 'utf8'));
      if (hits.length > 0) escapes[relative(repoRoot, abs).split('\\').join('/')] = hits;
    }
  }
  return escapes;
}

function collectTs(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTs(abs));
    else if (entry.isFile() && /\.tsx?$/.test(entry.name)) out.push(abs);
  }
  return out;
}

export function scanWebcomponentsWebappEscapes() {
  const escapes = {};
  for (const dir of WEBCOMPONENTS_SCAN_DIRS) {
    for (const abs of collectTs(dir)) {
      const pkgRel = relative(WEBCOMPONENTS_PKG, abs).split('\\').join('/');
      const hits = findWebcomponentsWebappEscapes(pkgRel, readFileSync(abs, 'utf8'));
      if (hits.length > 0) escapes[relative(repoRoot, abs).split('\\').join('/')] = hits;
    }
  }
  return escapes;
}

export function compareToBaseline(current, baseline) {
  const failures = [];
  for (const [file, count] of Object.entries(current)) {
    const allowed = baseline[file] ?? 0;
    if (count > allowed) {
      failures.push(
        `${file}: ${count} layer back-edge(s), baseline allows ${allowed} — do not import ` +
          'from a higher layer; move pure helpers into a lower-layer module instead.'
      );
    } else if (count < allowed) {
      failures.push(
        `${file}: ${count} layer back-edge(s), baseline says ${allowed} — thanks for paying ` +
          'debt down! Ratchet the baseline: node packages/dev-tools/tools/check-layer-back-edges.mjs --update'
      );
    }
  }
  for (const file of Object.keys(baseline)) {
    if (!(file in current)) {
      failures.push(
        `${file}: baseline entry is stale (file clean or gone) — run ` +
          'node packages/dev-tools/tools/check-layer-back-edges.mjs --update'
      );
    }
  }
  return failures;
}

function sortedCounts(counts) {
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function reportEscapes(escapes, detailForHit) {
  const files = Object.keys(escapes);
  if (files.length === 0) return false;
  for (const file of files) {
    for (const h of escapes[file]) {
      process.stderr.write(
        `::error file=${file},line=${h.line}::${file}:${h.line} imports '${h.specifier}' — ${detailForHit(h)}\n`
      );
    }
  }
  return true;
}

function reportStackFailures(stack, current, baseline, failures) {
  for (const failure of failures) process.stderr.write(`::error::${failure}\n`);
  const srcPrefix = `${relative(repoRoot, stack.scanRoot).split('\\').join('/')}/`;
  for (const [file, count] of Object.entries(current)) {
    if (count <= (baseline[file] ?? 0)) continue;
    const hits = findLayerBackEdges(
      file.slice(srcPrefix.length),
      readFileSync(resolve(repoRoot, file), 'utf8'),
      stack
    );
    for (const h of hits) {
      process.stderr.write(`  ${file}:${h.line} ${h.from} → ${h.to}: '${h.specifier}'\n`);
    }
  }
  process.stderr.write(
    `\n${failures.length} ${stack.id} layer-stack violation(s). The ${stack.id} layer stack ` +
      `(${stack.stackLabel}) requires imports to point down. Move the pure helper into the ` +
      'lower layer (see docs/review-patterns.md § Layer-stack import direction) rather than ' +
      'growing the baseline.\n'
  );
}

function main() {
  const stackScans = LAYER_STACKS.map((stack) => ({
    stack,
    current: scanStackBackEdges(stack),
  }));
  const escapes = scanCrossPackageEscapes();
  const chromeExtEscapes = scanChromeExtensionWebappEscapes();
  const webcomponentsEscapes = scanWebcomponentsWebappEscapes();

  if (argv.includes('--update')) {
    for (const { stack, current } of stackScans) {
      writeFileSync(stack.baselinePath, `${JSON.stringify(sortedCounts(current), null, 2)}\n`);
      const total = Object.values(current).reduce((a, b) => a + b, 0);
      process.stdout.write(
        `${stack.id} baseline updated: ${total} grandfathered layer back-edge(s) in ${Object.keys(current).length} file(s)\n`
      );
    }
    return;
  }

  if (
    reportEscapes(
      escapes,
      (h) =>
        `a relative import out of packages/webapp/src into ${h.to}. Move the shared code ` +
        'into @slicc/shared-ts and import it by package name instead.'
    ) ||
    reportEscapes(
      chromeExtEscapes,
      () =>
        'packages/chrome-extension (src and tests) must not depend on packages/webapp/src. ' +
        'The only permitted exception is a top-level `import type { ... }` clause from ' +
        'kernel/messages.ts (compiles away — no runtime coupling). Value imports are not ' +
        'exempt. Move shared protocol code into @slicc/shared-ts instead.'
    ) ||
    reportEscapes(
      webcomponentsEscapes,
      () =>
        'packages/webcomponents must not depend on packages/webapp/src. Inject a ' +
        'callback or move the helper into webcomponents instead.'
    )
  ) {
    process.exit(1);
  }

  let stackFailed = false;
  for (const { stack, current } of stackScans) {
    const baseline = JSON.parse(readFileSync(stack.baselinePath, 'utf8'));
    const failures = compareToBaseline(current, baseline);
    if (failures.length === 0) continue;
    stackFailed = true;
    reportStackFailures(stack, current, baseline, failures);
  }
  if (stackFailed) process.exit(1);

  const totals = stackScans.map(({ stack, current }) => {
    const n = Object.values(current).reduce((a, b) => a + b, 0);
    return `${n} ${stack.id}`;
  });
  const fileCount = stackScans.reduce((n, { current }) => n + Object.keys(current).length, 0);
  process.stdout.write(
    `ok: no new layer back-edges, no cross-package escapes in packages/webapp/src, no ` +
      `packages/chrome-extension (src+tests) → packages/webapp/src escapes, and no ` +
      `packages/webcomponents → packages/webapp/src escapes ` +
      `(${totals.join(', ')} grandfathered in ${fileCount} baselined files)\n`
  );
}

if (import.meta.url === pathToFileURL(argv[1] ?? '').href) main();
