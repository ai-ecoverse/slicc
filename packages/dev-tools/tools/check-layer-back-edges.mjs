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
 * ranked layer is the target, and are never a target themselves.
 *
 * The same pass also catches the *cross-package* form of the same mistake: a
 * relative specifier that climbs out of packages/webapp/src into a sibling
 * package's source. Ranked layers are webapp-internal directories, so a
 * `../../../node-server/src/x.js` lands in no layer at all and the ratchet
 * above cannot see it — yet it is the worse violation, since the browser-first
 * webapp then roots its bundle in a Node CLI package (#2798). That check is
 * zero-tolerance rather than baselined: the tree is clean today.
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
 * back-edge target themselves.
 */
const UNRANKED_IMPORTER_RANK = LAYER_RANK.ui - 0.5;

/** A scannable webapp source file (not a test). */
export function isWebappSource(name) {
  return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name);
}

// Match the specifier of any relative static import / re-export, bare
// side-effect `import '…'`, dynamic `import('…')`, or `require('…')`.
// `\s` spans newlines so Prettier's multiline `await import(\n  '../ui/x.js'\n)`
// form matches too.
const RELATIVE_IMPORT_RE =
  /(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)['"](\.\.?\/[^'"]+)['"]/g;

/** The stack layer a `packages/webapp/src`-relative path belongs to. */
export function layerOf(relPath) {
  return relPath.split('/')[0];
}

/**
 * Find every import in `source` that points UP the stack from `importerRel`
 * (a `packages/webapp/src`-relative path). Returns
 * `[{ line, specifier, from, to }]`; comments are ignored.
 */
export function findLayerBackEdges(importerRel, source) {
  const fromLayer = layerOf(importerRel);
  const fromRank = LAYER_RANK[fromLayer] ?? UNRANKED_IMPORTER_RANK;
  const importerDir = dirname(importerRel);
  const hits = [];
  const stripped = stripComments(source);
  for (const m of stripped.matchAll(RELATIVE_IMPORT_RE)) {
    const target = resolve('/', importerDir, m[1]).slice(1);
    const toLayer = layerOf(target);
    const toRank = LAYER_RANK[toLayer];
    if (toRank === undefined || toRank <= fromRank) continue;
    const line = stripped.slice(0, m.index).split('\n').length;
    hits.push({ line, specifier: m[1], from: fromLayer, to: toLayer });
  }
  return hits;
}

/**
 * Find every relative import in `source` that climbs OUT of
 * `packages/webapp/src` into another package. Returns
 * `[{ line, specifier, to }]` where `to` is the repo-relative target.
 *
 * Specifiers carrying a query (`?raw`, `?url`, …) are asset-pipeline imports —
 * the bundler inlines the file's bytes, so `vfs-root/etc/sudoers?raw` creates
 * no module edge to another package's code — and are allowed. Shared *code*
 * must travel through a package entry point (`@slicc/shared-ts`), which makes
 * the dependency direction explicit in package.json.
 */
export function findCrossPackageEscapes(importerRel, source) {
  const importerDir = dirname(importerRel);
  const hits = [];
  const stripped = stripComments(source);
  for (const m of stripped.matchAll(RELATIVE_IMPORT_RE)) {
    const specifier = m[1];
    if (specifier.includes('?')) continue;
    const target = relative(SCAN_ROOT, resolve(SCAN_ROOT, importerDir, specifier));
    if (!target.startsWith('..')) continue;
    const line = stripped.slice(0, m.index).split('\n').length;
    hits.push({
      line,
      specifier,
      to: relative(repoRoot, resolve(SCAN_ROOT, importerDir, specifier))
        .split('\\')
        .join('/'),
    });
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
function collect(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...collect(abs));
    else if (entry.isFile() && isWebappSource(entry.name)) out.push(abs);
  }
  return out;
}

/** Scan the tree; returns `{ 'packages/webapp/src/...': count }` for files with back-edges. */
export function scanBackEdges() {
  const counts = {};
  for (const abs of collect(SCAN_ROOT)) {
    const srcRel = relative(SCAN_ROOT, abs).split('\\').join('/');
    const hits = findLayerBackEdges(srcRel, readFileSync(abs, 'utf8'));
    if (hits.length > 0) counts[relative(repoRoot, abs).split('\\').join('/')] = hits.length;
  }
  return counts;
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

function main() {
  const current = scanBackEdges();
  const escapes = scanCrossPackageEscapes();

  if (argv.includes('--update')) {
    writeFileSync(BASELINE_PATH, `${JSON.stringify(sortedCounts(current), null, 2)}\n`);
    const total = Object.values(current).reduce((a, b) => a + b, 0);
    process.stdout.write(
      `baseline updated: ${total} grandfathered layer back-edge(s) in ${Object.keys(current).length} file(s)\n`
    );
    return;
  }

  if (Object.keys(escapes).length > 0) {
    for (const [file, hits] of Object.entries(escapes)) {
      for (const h of hits) {
        process.stderr.write(
          `::error file=${file},line=${h.line}::${file}:${h.line} imports '${h.specifier}' — ` +
            `a relative import out of packages/webapp/src into ${h.to}. Move the shared code ` +
            'into @slicc/shared-ts and import it by package name instead.\n'
        );
      }
    }
    process.exit(1);
  }

  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  const failures = compareToBaseline(current, baseline);

  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`::error::${failure}\n`);
    const srcPrefix = 'packages/webapp/src/';
    for (const [file, count] of Object.entries(current)) {
      if (count <= (baseline[file] ?? 0)) continue;
      const hits = findLayerBackEdges(
        file.slice(srcPrefix.length),
        readFileSync(resolve(repoRoot, file), 'utf8')
      );
      for (const h of hits) {
        process.stderr.write(`  ${file}:${h.line} ${h.from} → ${h.to}: '${h.specifier}'\n`);
      }
    }
    process.stderr.write(
      `\n${failures.length} layer-stack violation(s). The webapp layer stack ` +
        '(fs → shell/git → cdp → tools → core → scoops → ui) requires imports to point ' +
        'down. Move the pure helper into the lower layer (see docs/review-patterns.md § ' +
        'Layer-stack import direction) rather than growing the baseline.\n'
    );
    process.exit(1);
  }

  const total = Object.values(current).reduce((a, b) => a + b, 0);
  process.stdout.write(
    `ok: no new layer back-edges and no cross-package escapes in packages/webapp/src ` +
      `(${total} grandfathered in ${Object.keys(current).length} baselined files)\n`
  );
}

if (import.meta.url === pathToFileURL(argv[1] ?? '').href) main();
