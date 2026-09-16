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

export function isWebappSource(name) {
  return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name);
}

export function isPackageSource(name) {
  return isWebappSource(name) && !name.endsWith('.d.ts');
}

function isCloudflareWorkerSource(name) {
  return isPackageSource(name) && name !== 'preview-bridge-assets.ts';
}

const RELATIVE_IMPORT_RE =
  /(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)['"](\.\.?\/[^'"]+)['"]/g;

export function layerOf(relPath) {
  return relPath.split('/')[0];
}

function canonRel(relPath) {
  const rel = relPath.split('\\').join('/');
  const q = rel.indexOf('?');
  const path = q >= 0 ? rel.slice(0, q) : rel;
  return path.replace(/\.jsx$/, '.tsx').replace(/\.js$/, '.ts');
}

function baseName(relPath) {
  return canonRel(relPath).split('/').pop();
}

function topDir(relPath) {
  const rel = canonRel(relPath);
  const i = rel.indexOf('/');
  return i === -1 ? '' : rel.slice(0, i);
}

const NODE_SERVER_ENTRY = new Set([
  'index.ts',
  'electron-main.ts',
  'install-cli.ts',
  'publish-chrome-web-store.ts',
  'release-package.ts',
  'qa-setup.ts',
]);

const NODE_SERVER_TRANSPORT_FILES = new Set([
  'bridge-security.ts',
  'chrome-launch.ts',
  'fetch-proxy-gzip.ts',
  'fetch-proxy-headers.ts',
  'http-keepalive.ts',
  'hostfs.ts',
  'hostfs-watch.ts',
  'file-logger.ts',
  'runtime-flags.ts',
  'cli-log-dedup.ts',
]);

const NODE_SERVER_TRANSPORT_DIRS = new Set(['cdp-proxy']);

const NODE_SERVER_SERVICE_DIRS = new Set(['secrets', 'cloud', 'sudo', 'routes']);

const NODE_SERVER_SERVICE_FILES = new Set([
  'cloud-status.ts',
  'secrets-reload-endpoint.ts',
  'electron-controller.ts',
  'electron-federated-cdp.ts',
  'electron-runtime.ts',
  'electron-tray-follower.ts',
  'hosted-bootstrap.ts',
  'launch-url.ts',
  'links-middleware.ts',
  'leader-restart.ts',
  'browser-shutdown.ts',
]);

export function nodeServerLayerOf(relPath) {
  const rel = canonRel(relPath);
  const name = baseName(rel);
  const top = topDir(rel);
  if (!top && NODE_SERVER_ENTRY.has(name)) return 'entry';
  if (NODE_SERVER_TRANSPORT_DIRS.has(top) || (!top && NODE_SERVER_TRANSPORT_FILES.has(name))) {
    return 'transport';
  }
  if (NODE_SERVER_SERVICE_DIRS.has(top) || (!top && NODE_SERVER_SERVICE_FILES.has(name))) {
    return 'service';
  }
  return 'service';
}

export function chromeExtensionLayerOf(relPath) {
  const name = baseName(relPath);
  if (name === 'service-worker.ts' || name.endsWith('-entry.ts')) return 'entry';
  if (
    name === 'bridge-sw.ts' ||
    name === 'secrets-sw.ts' ||
    name === 'secrets-storage.ts' ||
    name === 'sw-pinned-port.ts'
  ) {
    return 'bridge';
  }
  if (name.endsWith('-sw.ts')) return 'sw';
  return 'shared';
}

const CLOUDFLARE_ENTRY = new Set(['index.ts', 'preview-worker.ts']);

const CLOUDFLARE_SHARED = new Set([
  'shared.ts',
  'links.ts',
  'timing-safe-equal.ts',
  'webhook-body.ts',
  'oauth-registry.ts',
  'apns.ts',
  'apns-provider-token.ts',
  'preview-host.ts',
  'preview-cache.ts',
  'persistent-preview-storage.ts',
  'preview-continuity.ts',
  'turn-credentials.ts',
  'preview-bridge-assets.ts',
]);

const CLOUDFLARE_AUTH_FILES = new Set([
  'cloud/auth.ts',
  'cloud/auth-cache.ts',
  'cloud/auth-middleware.ts',
  'cloud/error-envelope.ts',
  'cloud/proxy-config.ts',
  'cloud/caps.ts',
  'cloud/local-registry.ts',
  'cloud/rate-limit.ts',
]);

const CLOUDFLARE_DO_FILES = new Set(['cloud/cloud-sessions-do.ts', 'cloud/cone-config-bridge.ts']);

export function cloudflareWorkerLayerOf(relPath) {
  const rel = canonRel(relPath);
  const name = baseName(rel);
  if (CLOUDFLARE_ENTRY.has(name)) return 'entry';
  if (rel.startsWith('auth/') || CLOUDFLARE_AUTH_FILES.has(rel)) return 'auth';
  if (CLOUDFLARE_DO_FILES.has(rel)) return 'do';
  if (name.startsWith('session-tray') || name.startsWith('webhook-home')) return 'do';
  if (CLOUDFLARE_SHARED.has(name)) return 'shared';
  return 'route';
}

function makeStack({
  id,
  scanRootRel,
  baselineName,
  layerRank,
  layerOfFn,
  topLayer,
  forbidLateralLayers,
  stackLabel,
  isSource,
}) {
  const baselinePath = resolve(dirname(Filename), baselineName);
  return {
    id,
    scanRoot: resolve(repoRoot, scanRootRel),
    scanRootRel,
    baselinePath,
    baselineRel: relative(repoRoot, baselinePath).split('\\').join('/'),
    layerRank,
    layerOf: layerOfFn,
    unrankedImporterRank: layerRank[topLayer] - 0.5,
    forbidLateralLayers: forbidLateralLayers ?? new Set(),
    stackLabel,
    isSource: isSource ?? isPackageSource,
  };
}

export const WEBAPP_STACK = makeStack({
  id: 'webapp',
  scanRootRel: 'packages/webapp/src',
  baselineName: 'layer-back-edge-baseline.json',
  layerRank: LAYER_RANK,
  layerOfFn: layerOf,
  topLayer: 'ui',
  stackLabel: 'fs → shell/git → cdp → tools → core → scoops → ui',
  isSource: isWebappSource,
});

export const NODE_SERVER_STACK = makeStack({
  id: 'node-server',
  scanRootRel: 'packages/node-server/src',
  baselineName: 'layer-back-edge-baseline.node-server.json',
  layerRank: { transport: 0, service: 1, entry: 2 },
  layerOfFn: nodeServerLayerOf,
  topLayer: 'entry',
  stackLabel: 'transport/bridge → services → cli entrypoints',
});

export const CHROME_EXTENSION_STACK = makeStack({
  id: 'chrome-extension',
  scanRootRel: 'packages/chrome-extension/src',
  baselineName: 'layer-back-edge-baseline.chrome-extension.json',
  layerRank: { shared: 0, bridge: 1, sw: 2, entry: 3 },
  layerOfFn: chromeExtensionLayerOf,
  topLayer: 'entry',
  stackLabel: 'shared → bridge-sw/secrets-* → feature SW → entry points',
});

export const CLOUDFLARE_WORKER_STACK = makeStack({
  id: 'cloudflare-worker',
  scanRootRel: 'packages/cloudflare-worker/src',
  baselineName: 'layer-back-edge-baseline.cloudflare-worker.json',
  layerRank: { shared: 0, auth: 0, do: 0, route: 1, entry: 2 },
  layerOfFn: cloudflareWorkerLayerOf,
  topLayer: 'entry',
  forbidLateralLayers: new Set(['route']),
  stackLabel: 'shared/links/auth → route modules → index.ts (no sideways route imports)',
  isSource: isCloudflareWorkerSource,
});

export const LAYER_PACKAGES = [
  WEBAPP_STACK,
  NODE_SERVER_STACK,
  CHROME_EXTENSION_STACK,
  CLOUDFLARE_WORKER_STACK,
];

export function findLayerBackEdges(importerRel, source, stack = WEBAPP_STACK) {
  const fromLayer = stack.layerOf(importerRel);
  const fromRank = stack.layerRank[fromLayer] ?? stack.unrankedImporterRank;
  const importerDir = dirname(importerRel);
  const hits = [];
  const stripped = stripComments(source);
  for (const m of stripped.matchAll(RELATIVE_IMPORT_RE)) {
    const target = resolve('/', importerDir, m[1]).slice(1);
    const toLayer = stack.layerOf(target);
    const toRank = stack.layerRank[toLayer];
    if (toRank === undefined) continue;
    const upward = toRank > fromRank;
    const lateral =
      toRank === fromRank && fromLayer === toLayer && stack.forbidLateralLayers.has(fromLayer);
    if (!upward && !lateral) continue;
    const line = stripped.slice(0, m.index).split('\n').length;
    hits.push({ line, specifier: m[1], from: fromLayer, to: toLayer });
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

function collectFiles(dir, pred) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(abs, pred));
    else if (entry.isFile() && pred(entry.name)) out.push(abs);
  }
  return out;
}

function collect(dir) {
  return collectFiles(dir, isWebappSource);
}

export function scanLayerBackEdges(stack) {
  const counts = {};
  for (const abs of collectFiles(stack.scanRoot, stack.isSource)) {
    const srcRel = relative(stack.scanRoot, abs).split('\\').join('/');
    const hits = findLayerBackEdges(srcRel, readFileSync(abs, 'utf8'), stack);
    if (hits.length > 0) counts[relative(repoRoot, abs).split('\\').join('/')] = hits.length;
  }
  return counts;
}

export function scanBackEdges() {
  return scanLayerBackEdges(WEBAPP_STACK);
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

const TYPE_ONLY_NAMED_CLAUSE_RE = /import\s+type\s*\{[^}]*\}\s*from\s*['"](\.\.?\/[^'"]+)['"]/g;

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
      const fromOffset = m[0].lastIndexOf('from');
      const fromIndex = m.index + fromOffset;
      const list = typeOnlyFromIndices.get(m[1]) ?? [];
      list.push(fromIndex);
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
    if (!raw.includes('$')) {
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
  return collectFiles(dir, (name) => /\.tsx?$/.test(name));
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

function reportPackageFailures(stack, current, baseline, failures) {
  for (const failure of failures) process.stderr.write(`::error::${failure}\n`);
  const srcPrefix = `${stack.scanRootRel}/`;
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
  const lateralNote = stack.forbidLateralLayers.size
    ? ', and modules in a no-sideways layer may not import each other'
    : '';
  process.stderr.write(
    `\n${failures.length} layer-stack violation(s) in ${stack.id}. The stack ` +
      `(${stack.stackLabel}) requires imports to point down${lateralNote}. ` +
      'Move the helper into the lower layer rather than growing the baseline.\n'
  );
}

function main() {
  const scanned = LAYER_PACKAGES.map((stack) => ({
    stack,
    current: scanLayerBackEdges(stack),
  }));
  const escapes = scanCrossPackageEscapes();
  const chromeExtEscapes = scanChromeExtensionWebappEscapes();
  const webcomponentsEscapes = scanWebcomponentsWebappEscapes();

  if (argv.includes('--update')) {
    const parts = [];
    for (const { stack, current } of scanned) {
      writeFileSync(stack.baselinePath, `${JSON.stringify(sortedCounts(current), null, 2)}\n`);
      const total = Object.values(current).reduce((a, b) => a + b, 0);
      parts.push(`${stack.id}: ${total} in ${Object.keys(current).length} file(s)`);
    }
    process.stdout.write(`baseline updated: ${parts.join('; ')}\n`);
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

  let failed = false;
  for (const { stack, current } of scanned) {
    const baseline = JSON.parse(readFileSync(stack.baselinePath, 'utf8'));
    const failures = compareToBaseline(current, baseline);
    if (failures.length === 0) continue;
    failed = true;
    reportPackageFailures(stack, current, baseline, failures);
  }
  if (failed) process.exit(1);

  const total = scanned.reduce(
    (n, { current }) => n + Object.values(current).reduce((a, b) => a + b, 0),
    0
  );
  const fileCount = scanned.reduce((n, { current }) => n + Object.keys(current).length, 0);
  const ids = LAYER_PACKAGES.map((p) => p.id).join(', ');
  process.stdout.write(
    `ok: no new layer back-edges (${ids}), no cross-package escapes in packages/webapp/src, no ` +
      `packages/chrome-extension (src+tests) → packages/webapp/src escapes, and no ` +
      `packages/webcomponents → packages/webapp/src escapes ` +
      `(${total} grandfathered in ${fileCount} baselined files)\n`
  );
}

if (import.meta.url === pathToFileURL(argv[1] ?? '').href) main();
