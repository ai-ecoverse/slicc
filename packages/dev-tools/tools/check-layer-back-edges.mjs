#!/usr/bin/env node
/**
 * Layer-stack back-edge ratchet: no NEW import that points UP the stack.
 *
 * The webapp's documented layer stack is
 *   fs → shell/git → cdp → tools → core → scoops → ui
 * An import from a lower layer into a higher one inverts the stack: it drags
 * DOM-heavy modules into the kernel-worker bundle (the `ui/` case) or, one
 * rung lower, entangles transports with orchestration (the `cdp/` → `scoops/`
 * case, #1950). The `ui/` variant alone has recurred at least six times
 * (#869, #968, #1071, #1145, #1630, #1772) and was never caught at review
 * time — hence this deterministic gate, which now covers every rung rather
 * than only the topmost one.
 *
 * Unlike check-no-ui-imports-in-providers.mjs (a zero-tolerance zone),
 * this scan covers ALL of packages/webapp/src/ and enforces a frozen
 * baseline (layer-back-edge-baseline.json): pre-existing back-edges are
 * grandfathered per file, new ones fail, and fixed ones must be removed
 * from the baseline (`--update` regenerates it). The baseline is a one-way
 * ratchet — counts may only go down.
 *
 * Directories not named in LAYER_RANK (kernel/, providers/, speech/, …) sit
 * outside the documented stack; they are scanned as importers only when a
 * ranked layer is the target, and are never a target themselves — except
 * scoops/ value-importing kernel/ (#3231). Ranking kernel itself is not
 * cheap: cdp/, shell/, and core/ already value-import it. A top-level
 * `import type { … } from` clause still erases and is allowed.
 *
 * The same pass also catches the *cross-package* form of the same mistake: a
 * relative specifier that climbs out of packages/webapp/src into a sibling
 * package's source. Ranked layers are webapp-internal directories, so a
 * `../../../node-server/src/x.js` lands in no layer at all and the ratchet
 * above cannot see it — yet it is the worse violation, since the browser-first
 * webapp then roots its bundle in a Node CLI package (#2798). That check is
 * zero-tolerance rather than baselined: the tree is clean today.
 *
 * A third pass closes the reciprocal gap (#2276 slice E / #3047, category 10):
 * packages/chrome-extension (src AND tests) importing FROM packages/webapp/src.
 * Nothing above catches that direction — the cross-package-escape check only
 * scans webapp/src as the importer. The thin extension must not depend on
 * webapp's runtime; the shared protocol modules it needs
 * (extension-bridge-protocol, proxy-headers, discovery-link, well-known-probe,
 * handoff-link, link-header, the cdp/types TargetInfo subset) moved to
 * @slicc/shared-ts, with webapp re-exports so no webapp-internal caller moves.
 * The ONE exception is `import type { ... } from '.../kernel/messages.js'`:
 * that 1500-line message-envelope union is core webapp-internal kernel
 * infrastructure used by 11+ webapp files, not extension-specific, so moving
 * it would invert the dependency for no bundle-coupling benefit — `import type`
 * compiles away entirely. The exemption applies to src and tests; it does NOT
 * cover value imports. Zero-tolerance, no baseline: every other form (value
 * imports, dynamic import(), mixed `{ type X, Y }` clauses, namespace/default
 * imports, or a type-only import of any OTHER webapp module) is banned.
 * Scan roots match the webcomponents pass: src + tests.
 *
 * A fourth pass closes the library-cycle gap (#3027): packages/webcomponents
 * (src and tests) importing FROM packages/webapp/src. webcomponents is a leaf
 * library that webapp depends on; a relative climb into webapp/src inverts
 * that stack and is undeclared in package.json. Zero-tolerance, no baseline,
 * and no type-only exemption — inject a callback or move the helper down.
 *
 * The same ratchet also covers the other TypeScript applications (#3149), each
 * with its own layer order and baseline file so the gate can land green and
 * shrink later:
 *   node-server:        transport → services → entry
 *   chrome-extension:   shared/page → sw → entry (service-worker.ts)
 *   cloudflare-worker:  shared/links/auth → routes → entry (index.ts);
 *                       route modules must not import each other sideways
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { argv } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripComments } from './check-no-ui-imports-in-providers.mjs';

const Filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(Filename), '..', '..', '..');

const SCAN_ROOT = resolve(repoRoot, 'packages/webapp/src');
export const BASELINE_PATH = resolve(dirname(Filename), 'layer-back-edge-baseline.json');

/**
 * Rank of each documented layer. An import is a back-edge when the target's
 * rank is strictly greater than the importer's. `shell/` and `git/` share a
 * rung, so they may import each other.
 */
export const LAYER_RANK = {
  base: 0, // foundational layer (logger etc.) — shares the bottom rung with fs
  fs: 0,
  shell: 1,
  git: 1,
  cdp: 2,
  tools: 3,
  core: 4,
  scoops: 5,
  ui: 6,
};

/**
 * Unranked directories (kernel/, providers/, speech/, …) sit outside the
 * documented stack but below `ui/` — they are worker-resident, so a `ui/`
 * import from one of them is the same bundle-bloat back-edge the original
 * ui-only gate caught. They rank just under `ui/`: an import into `ui/` is a
 * back-edge, imports into every other layer are not, and they are never a
 * back-edge target themselves — except scoops/ value-importing kernel/ (#3231).
 */
const UNRANKED_IMPORTER_RANK = LAYER_RANK.ui - 0.5;

/** A scannable webapp source file (not a test). */
export function isWebappSource(name) {
  return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name);
}

/** Package source (not a test, not a `.d.ts` ambient). */
function isPackageSource(name) {
  return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts');
}

/** The stack layer a `packages/webapp/src`-relative path belongs to. */
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

/** Layer of a `packages/node-server/src`-relative path. */
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

/** Layer of a `packages/chrome-extension/src`-relative path. */
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

/** Layer of a `packages/cloudflare-worker/src`-relative path. */
export function cloudflareWorkerLayerOf(relPath) {
  const srcRel = toSourcePath(relPath);
  // `preview-worker.ts` is the `main` of `wrangler-preview.jsonc`.
  if (srcRel === 'index.ts' || srcRel === 'preview-worker.ts') return 'entry';
  if (WORKER_SHARED_FILES.has(srcRel) || srcRel.startsWith('auth/')) return 'shared';
  // `session-tray-*.ts` are DO internals; `session-tray.ts` itself is the route.
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

/** ESM specifiers use `.js` for `.ts` sources (NodeNext); classify by the on-disk name. */
function toSourcePath(relPath) {
  return relPath
    .replace(/\.jsx$/, '.tsx')
    .replace(/\.mjs$/, '.mts')
    .replace(/\.cjs$/, '.cts')
    .replace(/\.js$/, '.ts');
}

/**
 * Per-package layer stacks. `id: 'webapp'` is the original ratchet; the
 * others land with their own baseline files (#3149).
 * @type {ReadonlyArray<{
 *   id: string,
 *   scanRoot: string,
 *   baselinePath: string,
 *   layerRank: Record<string, number>,
 *   layerOf: (relPath: string) => string,
 *   unrankedImporterRank: number,
 *   isolatedLayers: ReadonlySet<string>,
 *   stackLabel: string,
 *   accept: (name: string) => boolean,
 * }>}
 */
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

/** Look up a stack by `id`; undefined when unknown. */
export function stackById(id) {
  return LAYER_STACKS.find((s) => s.id === id);
}

// Match the specifier of any relative static import / re-export, bare
// side-effect `import '…'`, dynamic `import('…')`, or `require('…')`.
// `\s` spans newlines so Prettier's multiline `await import(\n  '../ui/x.js'\n)`
// form matches too.
const RELATIVE_IMPORT_RE =
  /(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)['"](\.\.?\/[^'"]+)['"]/g;

// A full `import type { ... } from '<spec>'` clause. Deliberately does NOT
// match a mixed `import { type X, Y }` clause (that carries a real value
// import too), a type-only namespace/default import, or an `export type {
// ... } from '<spec>'` re-export (still a live binding at the type level,
// and not the narrow shape this repo grants) — the one exemption this repo
// grants is narrow on purpose. Shared by the chrome-extension webapp-escape
// pass and the scoops→kernel value-import check (#3231).
const TYPE_ONLY_NAMED_CLAUSE_RE = /import\s+type\s*\{[^}]*\}\s*from\s*['"](\.\.?\/[^'"]+)['"]/g;

/**
 * Absolute index of the module-clause `from` in a TYPE_ONLY_NAMED_CLAUSE_RE
 * match. Search starts after the type-brace `}` so a string literal name
 * like `"buffer-from"` cannot steal the offset (#3237 / #3249 P2).
 */
function typeOnlyFromKeywordIndex(match) {
  const brace = match[0].lastIndexOf('}');
  if (brace < 0) return -1;
  const kw = /\bfrom\s*['"]/.exec(match[0].slice(brace));
  return kw ? match.index + brace + kw.index : -1;
}

/**
 * True when a static `kernel` path segment comes after an interpolated
 * segment. Replacing `${…}` with a normal filename then hides the case
 * where the interpolation is `..` and walks into top-level `kernel/`
 * (#3251 P2).
 */
function kernelSegmentFollowsInterpolation(raw) {
  const parts = raw.split('?')[0].split('/');
  let seenInterp = false;
  for (const part of parts) {
    if (part.includes('${')) seenInterp = true;
    else if (part === 'kernel' && seenInterp) return true;
  }
  return false;
}

/**
 * Find every import in `source` that points UP the stack from `importerRel`
 * (a scan-root-relative path). Returns `[{ line, specifier, from, to }]`;
 * comments are ignored. `stack` defaults to the webapp stack so existing
 * callers keep their original semantics.
 *
 * For stacks with `isolatedLayers`, an import between two different files in
 * the same isolated layer is also a back-edge (sideways route→route).
 *
 * On the webapp stack, a scoops/ value import of kernel/ is a back-edge even
 * though kernel/ is unranked (#3231). Top-level `import type { … } from`
 * clauses still erase and are allowed. Quoted specifiers and static
 * template-literal `import(\`…\`)` are both scanned (#3237 P2).
 */
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

/**
 * Vite queries that make an import INERT: the bundler hands back the file's
 * bytes or a URL string, so `vfs-root/etc/sudoers?raw` creates no module edge
 * to another package's code. Deliberately an allowlist rather than "any query"
 * — `?worker` / `?sharedworker` bundle and EXECUTE the target, so exempting
 * them would let a wrong-direction package dependency straight back through
 * this gate. A new asset mode should be a conscious decision: fail closed.
 */
const INERT_ASSET_QUERIES = new Set(['raw', 'url']);

/**
 * Find every relative import in `source` that climbs OUT of
 * `packages/webapp/src` into another package. Returns
 * `[{ line, specifier, to }]` where `to` is the repo-relative target.
 *
 * Imports carrying an inert asset query (see `INERT_ASSET_QUERIES`) are allowed.
 * Shared *code* must travel through a package entry point (`@slicc/shared-ts`),
 * which makes the dependency direction explicit in package.json.
 */
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

/**
 * File paths listed in a parsed baseline object (its keys). Used by the
 * boy-scout gate (check-touched-exemptions.mjs) to treat the baseline as a
 * debt list. Non-object input yields [].
 */
export function baselineFiles(baseline) {
  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) return [];
  return Object.keys(baseline).filter((k) => typeof k === 'string' && k.length > 0);
}

/** Recursively collect source files under `dir`. */
function collect(dir, accept = isWebappSource) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...collect(abs, accept));
    else if (entry.isFile() && accept(entry.name)) out.push(abs);
  }
  return out;
}

/** Scan one stack; returns `{ 'packages/<pkg>/src/...': count }` for files with back-edges. */
export function scanStackBackEdges(stack) {
  const counts = {};
  for (const abs of collect(stack.scanRoot, stack.accept)) {
    const srcRel = relative(stack.scanRoot, abs).split('\\').join('/');
    const hits = findLayerBackEdges(srcRel, readFileSync(abs, 'utf8'), stack);
    if (hits.length > 0) counts[relative(repoRoot, abs).split('\\').join('/')] = hits.length;
  }
  return counts;
}

/** Scan the webapp tree; returns `{ 'packages/webapp/src/...': count }` for files with back-edges. */
export function scanBackEdges() {
  return scanStackBackEdges(WEBAPP_STACK);
}

/** Scan the tree; returns `{ 'packages/webapp/src/...': [hit] }` for files that escape. */
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

/**
 * The only packages/webapp/src target a chrome-extension src or tests file may
 * import, and only via a top-level `import type { ... } from '<spec>'` clause
 * (see the module docstring, #2276 slice E / #3047 / category 10).
 */
// `resolve()` preserves the specifier's `.js` extension (the ESM/NodeNext
// convention for a `.ts` source file) rather than resolving it to the
// on-disk `.ts` filename — match that, not the disk extension.
const ALLOWED_TYPE_ONLY_WEBAPP_TARGET = 'packages/webapp/src/kernel/messages.js';

// A dynamic `import(...)`/`require(...)` call whose specifier is a template
// literal (backtick) rather than a plain string — round-1 review, #2891:
// `RELATIVE_IMPORT_RE` only matches `'` / `"` quoted specifiers, so
// `` import(`../../webapp/src/x.js`) `` slipped past it entirely. Captures
// the raw backtick contents (which may itself contain `${...}`
// interpolation, in which case exact resolution isn't possible — see the
// caller's handling).
const BACKTICK_IMPORT_RE = /(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)`([^`]*)`/g;

// A dynamic `import(...)`/`require(...)` call built from string-literal
// segments joined with `+` (a concatenated specifier) rather than one
// literal — round-1 review, #2891. Captures the raw argument list; the
// caller reassembles the concatenated string from the quoted segments.
const CONCAT_CALL_ARGS_RE =
  /(?:import|require)\s*\(\s*((?:['"][^'"]*['"]\s*\+\s*)+['"][^'"]*['"])\s*\)/g;
const QUOTED_SEGMENT_RE = /['"]([^'"]*)['"]/g;

// TS triple-slash reference directive — syntactically a `///` comment (so
// `stripComments` blanks it out and it must be scanned on the RAW source
// first), but compiler-meaningful: it pulls the referenced file's types
// into the compilation unit exactly like an import would. Round-1 review,
// #2891.
const TRIPLE_SLASH_REFERENCE_RE = /\/\/\/\s*<reference\s+path=["']([^"']+)["']\s*\/>/g;

/** Resolve a scan-root-relative specifier against `packages/webapp/src`; null if it doesn't land there. */
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

/**
 * Find every relative import in `source` (rooted at `scanRoot`) that targets
 * packages/webapp/src. Returns `[{ line, specifier, to }]`. When
 * `allowTypeOnlyKernelMessages` is true, a top-level `import type { ... }`
 * clause targeting `kernel/messages.js` is excluded (chrome-extension only).
 * Covers quoted specifiers, template literals (interpolated or not),
 * concatenated `+`-joined specifiers inside `import()`/`require()`, and TS
 * triple-slash reference paths — none of those last three forms can ever be
 * the granted type-only exemption, so they are flagged unconditionally
 * whenever they land in webapp/src.
 */
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

  // RELATIVE_IMPORT_RE anchors its match on the `from '<spec>'` /
  // `import '<spec>'` fragment (see its definition above), so a type-only
  // named clause's match-start lines up with the `from` keyword too — index
  // by that shared anchor to know whether a given RELATIVE_IMPORT_RE hit was
  // produced by a `import type { ... } from` clause.
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
      // Fully static — resolve exactly like a quoted specifier. A literal `$`
      // without `${` is not interpolation (#3249 P2).
      const targetRel = resolveWebappTarget(scanRoot, importerDir, raw);
      if (targetRel !== null) hits.push({ line, specifier: raw, to: targetRel });
      continue;
    }
    // Interpolated — exact resolution isn't possible, but the literal text
    // (placeholders included) landing on webapp/src is itself the tell;
    // fail closed rather than silently letting it through unexamined.
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

/**
 * Find every relative import in a packages/chrome-extension file (src or
 * tests, package-relative path) that targets packages/webapp/src. Returns
 * `[{ line, specifier, to }]`; the one allowed occurrence (a type-only named
 * clause targeting `kernel/messages.ts`) is excluded. Value imports are
 * never exempt, including from tests (#3047).
 */
export function findChromeExtensionWebappEscapes(importerRel, source) {
  return findWebappEscapes(CHROME_EXT_PKG, importerRel, source, {
    allowTypeOnlyKernelMessages: true,
  });
}

/**
 * Find every relative import in a packages/webcomponents file (src or tests,
 * package-relative path) that targets packages/webapp/src. Zero-tolerance:
 * no type-only exemption (#3027).
 */
export function findWebcomponentsWebappEscapes(importerRel, source) {
  return findWebappEscapes(WEBCOMPONENTS_PKG, importerRel, source);
}

/** Scan chrome-extension src+tests; returns `{ 'packages/chrome-extension/...': [hit] }` for files that escape. */
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

/** Recursively collect .ts/.tsx files, including tests and stories. */
function collectTs(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTs(abs));
    else if (entry.isFile() && /\.tsx?$/.test(entry.name)) out.push(abs);
  }
  return out;
}

/** Scan webcomponents src+tests; returns `{ 'packages/webcomponents/...': [hit] }` for files that escape. */
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

/**
 * Compare `current` counts against `baseline`. Returns a list of failure
 * messages — empty when the tree matches the ratchet.
 */
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

/** Write GitHub-error annotations for an escape map. Returns true when any hit existed. */
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
