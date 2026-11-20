/**
 * Stand-in for `@pierre/highlights`, the WebAssembly highlighter that
 * `@pierre/diffs` 1.6 added as an alternative backend to Shiki.
 *
 * `@pierre/diffs` only reaches it when a caller passes
 * `preferredHighlighter: 'highlights'`; the default is `'shiki-js'`, and no
 * SLICC surface (`<slicc-diff>`, `slicc-quick-look`, sprinkles) selects it.
 * Shipped as-is it still costs ~800 KiB of lazily-emitted JS: a 470 KiB chunk
 * with the WASM inlined as base64, plus a Zed theme per bundled theme name.
 * `omitPierreHighlightsPlugin` in `vite.config.ts` resolves the package and its
 * theme loader here instead, so none of it is emitted.
 *
 * Every entry point fails loudly rather than rendering wrong output. Anyone
 * who does want the backend should drop the plugin and accept the budget
 * change, not route around this file.
 */

const UNAVAILABLE =
  "@pierre/highlights is not bundled in SLICC; use @pierre/diffs' default Shiki highlighter";

function unavailable(): never {
  throw new Error(UNAVAILABLE);
}

/** Backend probe `@pierre/diffs` calls before tokenizing. */
export function isSupportedLanguage(_lang: unknown): boolean {
  return unavailable();
}

/** One-shot tokenizer used by the `highlights` backend. */
export function codeToTokens(_code: unknown, _options?: unknown): never {
  return unavailable();
}

/** Incremental tokenizer used by the `highlights` stream and editor paths. */
export class LiveTokenizer {
  constructor(_options?: unknown) {
    unavailable();
  }
}

/**
 * The `@pierre/highlights/themes/loader` catalog. Empty, so the `highlights`
 * theme resolver reports "no valid theme loader" instead of fetching one.
 */
export const themes: Readonly<Record<string, never>> = Object.freeze({});

export { UNAVAILABLE as PIERRE_HIGHLIGHTS_UNAVAILABLE };
