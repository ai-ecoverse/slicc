/**
 * Vite build plugins that keep `@pierre/diffs` inside the total-JS budget.
 *
 * `@pierre/diffs` drives syntax highlighting through Shiki and, since 1.6,
 * optionally through `@pierre/highlights`. Both pull in far more than SLICC
 * renders, and Rolldown code-splits every lazily-imported grammar and theme into
 * its own chunk, so "lazy" still means "shipped": each chunk counts against
 * `packages/webapp/total-js-budget.json`. Nothing here is on a first-load path;
 * these plugins only trim what gets emitted.
 *
 * Both are registered for the page build AND the worker build (rolldown-vite
 * does not derive `worker.plugins` from `plugins`). The `<slicc-diff>` sprinkle
 * entry rides the page build.
 *
 * Kept out of `packages/webapp/src/` on purpose: this is build tooling. The
 * specifier predicates are unit-tested in
 * `tests/build/pierre-diffs-size-guards.test.ts`, which also pins the import
 * specifiers the installed `@pierre/diffs` actually uses, so a release that
 * moves them fails there instead of in the bundle-size job.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const shimsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../src/shims');

/** The curated grammar set `@pierre/diffs` is pointed at. */
export const SHIKI_BUNDLE_SHIM = resolve(shimsDir, 'shiki-bundle.ts');

/** The throwing stand-in for `@pierre/highlights`. */
export const PIERRE_HIGHLIGHTS_SHIM = resolve(shimsDir, 'pierre-highlights.ts');

/**
 * Specifiers through which `@pierre/diffs` obtains Shiki's `bundledLanguages`,
 * the full 332-grammar map: `shiki` up to 1.3.x, `shiki/langs` since 1.6
 * (lazily, in `resolveLanguage`). Left alone, ~5 MB of grammar chunks ship.
 *
 * Matching is exact: `shiki/bundle/web`, `shiki/langs/*`, `shiki/core` and the
 * engine subpaths must keep resolving to the real package, or the shim would
 * recurse into itself.
 */
export const CURATED_SHIKI_SPECIFIERS: ReadonlySet<string> = new Set(['shiki', 'shiki/langs']);

/** True when `source` should resolve to the curated Shiki shim. */
export function isCuratedShikiSpecifier(source: string): boolean {
  return CURATED_SHIKI_SPECIFIERS.has(source);
}

/**
 * True for `@pierre/highlights` and every subpath: its theme loader
 * (`/themes/loader`) and the per-theme modules that loader imports.
 */
export function isPierreHighlightsSpecifier(source: string): boolean {
  return source === '@pierre/highlights' || source.startsWith('@pierre/highlights/');
}

/**
 * Vite plugin: serve `@pierre/diffs` a curated Shiki language bundle.
 *
 * `src/shims/shiki-bundle.ts` re-exports Shiki's `bundle/web` subset plus the
 * languages this repo is written in.
 */
export function curatedShikiBundlePlugin() {
  return {
    name: 'curated-shiki-bundle',
    enforce: 'pre' as const,
    resolveId(source: string) {
      return isCuratedShikiSpecifier(source) ? SHIKI_BUNDLE_SHIM : undefined;
    },
  };
}

/**
 * Vite plugin: leave `@pierre/highlights` out of the build.
 *
 * `@pierre/diffs` 1.6 added it as an optional WebAssembly highlighter, reached
 * only with `preferredHighlighter: 'highlights'`; the default is Shiki, which
 * every SLICC surface uses. Emitted anyway it is ~800 KiB of lazy JS (the WASM
 * inlined as base64, plus a Zed theme per theme name). The shim throws if it is
 * ever called.
 */
export function omitPierreHighlightsPlugin() {
  return {
    name: 'omit-pierre-highlights',
    enforce: 'pre' as const,
    resolveId(source: string) {
      return isPierreHighlightsSpecifier(source) ? PIERRE_HIGHLIGHTS_SHIM : undefined;
    },
  };
}
