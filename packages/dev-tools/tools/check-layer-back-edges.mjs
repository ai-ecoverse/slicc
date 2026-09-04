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
 *
 * A third pass closes the reciprocal gap (#2276 slice E, category 10):
 * packages/chrome-extension/src importing FROM packages/webapp/src. Nothing
 * above catches that direction — the cross-package-escape check only scans
 * webapp/src as the importer. The thin extension must not depend on webapp's
 * runtime; the shared protocol modules it needs (extension-bridge-protocol,
 * proxy-headers, discovery-link, well-known-probe, handoff-link, link-header,
 * the cdp/types TargetInfo subset) moved to @slicc/shared-ts, with webapp
 * re-exports so no webapp-internal caller moves. The ONE exception is
 * `import type { ... } from '.../kernel/messages.js'`: that 1500-line
 * message-envelope union is core webapp-internal kernel infrastructure used
 * by 11+ webapp files, not extension-specific, so moving it would invert the
 * dependency for no bundle-coupling benefit — `import type` compiles away
 * entirely. Zero-tolerance, no baseline: every other form (value imports,
 * dynamic import(), mixed `{ type X, Y }` clauses, namespace/default
 * imports, or a type-only import of any OTHER webapp module) is banned.
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

const CHROME_EXT_SCAN_ROOT = resolve(repoRoot, 'packages/chrome-extension/src');

/**
 * The only packages/webapp/src target a chrome-extension/src file may import,
 * and only via a top-level `import type { ... } from '<spec>'` clause (see
 * the module docstring, #2276 slice E / category 10).
 */
// `resolve()` preserves the specifier's `.js` extension (the ESM/NodeNext
// convention for a `.ts` source file) rather than resolving it to the
// on-disk `.ts` filename — match that, not the disk extension.
const ALLOWED_TYPE_ONLY_WEBAPP_TARGET = 'packages/webapp/src/kernel/messages.js';

// A full `import type { ... } from '<spec>'` clause. Deliberately does NOT
// match a mixed `import { type X, Y }` clause (that carries a real value
// import too), a type-only namespace/default import, or an `export type {
// ... } from '<spec>'` re-export (still a live binding at the type level,
// and not the narrow shape this repo grants) — the one exemption this repo
// grants is narrow on purpose.
const TYPE_ONLY_NAMED_CLAUSE_RE = /import\s+type\s*\{[^}]*\}\s*from\s*['"](\.\.?\/[^'"]+)['"]/g;

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

/** Resolve a chrome-extension/src-relative specifier against `packages/webapp/src`; null if it doesn't land there. */
function resolveWebappTarget(importerDir, specifier) {
  const queryAt = specifier.indexOf('?');
  const abs = resolve(
    CHROME_EXT_SCAN_ROOT,
    importerDir,
    queryAt >= 0 ? specifier.slice(0, queryAt) : specifier
  );
  const targetRel = relative(repoRoot, abs).split('\\').join('/');
  return targetRel.startsWith('packages/webapp/src/') ? targetRel : null;
}

/**
 * Find every relative import in a packages/chrome-extension/src file that
 * targets packages/webapp/src. Returns `[{ line, specifier, to }]`; the one
 * allowed occurrence (a type-only named clause targeting
 * `kernel/messages.ts`) is excluded. Covers quoted specifiers, template
 * literals (interpolated or not), concatenated `+`-joined specifiers inside
 * `import()`/`require()`, and TS triple-slash reference paths — none of
 * those last three forms can ever be the granted type-only exemption, so
 * they are flagged unconditionally whenever they land in webapp/src.
 */
export function findChromeExtensionWebappEscapes(importerRel, source) {
  const importerDir = dirname(importerRel);

  const hits = [];
  for (const m of source.matchAll(TRIPLE_SLASH_REFERENCE_RE)) {
    const to = resolveWebappTarget(importerDir, m[1]);
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
  for (const m of stripped.matchAll(TYPE_ONLY_NAMED_CLAUSE_RE)) {
    const fromOffset = m[0].lastIndexOf('from');
    const fromIndex = m.index + fromOffset;
    const list = typeOnlyFromIndices.get(m[1]) ?? [];
    list.push(fromIndex);
    typeOnlyFromIndices.set(m[1], list);
  }

  for (const m of stripped.matchAll(RELATIVE_IMPORT_RE)) {
    const specifier = m[1];
    const targetRel = resolveWebappTarget(importerDir, specifier);
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
      // Fully static — resolve exactly like a quoted specifier.
      const targetRel = resolveWebappTarget(importerDir, raw);
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
    const targetRel = resolveWebappTarget(importerDir, joined);
    if (targetRel === null) continue;
    const line = stripped.slice(0, m.index).split('\n').length;
    hits.push({ line, specifier: joined, to: targetRel });
  }

  return hits;
}

/** Scan the tree; returns `{ 'packages/chrome-extension/src/...': [hit] }` for files that escape. */
export function scanChromeExtensionWebappEscapes() {
  const escapes = {};
  for (const abs of collect(CHROME_EXT_SCAN_ROOT)) {
    const srcRel = relative(CHROME_EXT_SCAN_ROOT, abs).split('\\').join('/');
    const hits = findChromeExtensionWebappEscapes(srcRel, readFileSync(abs, 'utf8'));
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
  const chromeExtEscapes = scanChromeExtensionWebappEscapes();

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

  if (Object.keys(chromeExtEscapes).length > 0) {
    for (const [file, hits] of Object.entries(chromeExtEscapes)) {
      for (const h of hits) {
        process.stderr.write(
          `::error file=${file},line=${h.line}::${file}:${h.line} imports '${h.specifier}' — ` +
            'packages/chrome-extension/src must not depend on packages/webapp/src. The only ' +
            'permitted exception is a top-level `import type { ... }` clause from ' +
            'kernel/messages.ts (compiles away — no runtime coupling). Move shared protocol ' +
            'code into @slicc/shared-ts instead.\n'
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
    `ok: no new layer back-edges, no cross-package escapes in packages/webapp/src, and no ` +
      `packages/chrome-extension/src → packages/webapp/src escapes ` +
      `(${total} grandfathered in ${Object.keys(current).length} baselined files)\n`
  );
}

if (import.meta.url === pathToFileURL(argv[1] ?? '').href) main();
