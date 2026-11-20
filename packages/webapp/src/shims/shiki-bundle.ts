/**
 * A curated Shiki language bundle for the file previewer.
 *
 * `@pierre/diffs` resolves languages against Shiki's `bundledLanguages`, the
 * FULL grammar set — 332 languages. Up to 1.3.x it imported that map from
 * `shiki`; since 1.6 it imports it lazily from `shiki/langs`. Left alone, Vite
 * code-splits all of them into ~400 lazily-fetched chunks that still ship,
 * which blows the total-JS-payload budget in `packages/webapp/package.json`.
 *
 * `curatedShikiBundlePlugin` in `vite.config.ts` points BOTH specifiers here,
 * in the page, worker and sprinkle-entry builds alike. The set is Shiki's own
 * `bundle/web` subset — 78 languages, every web and scripting language a
 * preview realistically hits — plus the handful this repo would otherwise have
 * LOST, since SLICC itself is written in them: Go, Rust and Swift are shipped
 * packages here, `.toml` is everyday config, and `diff` renders patch files.
 *
 * Everything else Shiki exports is re-exported untouched, so this is a drop-in
 * for the parts of the API `@pierre/diffs` actually calls (`bundledLanguages`,
 * plus `createHighlighter`, `codeToHtml`, the regex engines and the
 * CSS-variables theme helpers that 1.3.x took from the package root).
 *
 * ## Adding a language
 *
 * Add an entry to `EXTRA_LANGUAGES` pointing at `shiki/langs/<name>.mjs`; each
 * costs one lazily-fetched chunk. Trimming BELOW `bundle/web` is not worth it —
 * measured, going from 78 languages to 37 moved the payload by under 200 KB,
 * because the weight is Shiki's engine and theme machinery rather than the
 * grammars themselves.
 *
 * A file whose language is absent still previews; it renders unhighlighted
 * rather than failing.
 */

import { bundledLanguages as webLanguages } from 'shiki/bundle/web';

export * from 'shiki/bundle/web';

/**
 * The two regex engines, which `bundle/web` does not re-export.
 *
 * `@pierre/diffs` imports both by name from the package root (it chooses
 * between them via `preferredHighlighter`), so both are forwarded from their
 * real subpaths. Neither carries grammars.
 */
export { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
export { createOnigurumaEngine } from 'shiki/engine/oniguruma';

/**
 * Languages absent from `bundle/web` that this repo needs anyway.
 *
 * The loader shape (`() => import(...)`) matches Shiki's own, so consumers
 * cannot tell these apart from bundled entries.
 */
const EXTRA_LANGUAGES = {
  go: () => import('shiki/langs/go.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
} as const;

/**
 * The language map `@pierre/diffs` resolves against.
 *
 * An explicit named export deliberately shadows the one re-exported by the
 * `export *` above — that precedence is what swaps the bundle without having to
 * intercept the rest of the module.
 */
export const bundledLanguages = {
  ...webLanguages,
  ...EXTRA_LANGUAGES,
} as typeof webLanguages & typeof EXTRA_LANGUAGES;
