/**
 * Pure, dependency-free helpers that make Biome lint/format `.jsh`/`.bsh`
 * shell scripts correctly.
 *
 * `.jsh` scripts and `.bsh` browser helpers both run as an AsyncFunction
 * body (see `kernel/realm/realm-module-system.ts`), so top-level `await`
 * AND top-level `return` are valid there. Biome's file-mode parser maps a
 * bare `.jsh`/`.bsh` body to a module and emits a bogus "return outside of
 * function" parse error, so the body is wrapped in an async function before
 * Biome sees it and the resulting diagnostic byte spans are shifted back.
 *
 * This module has NO imports on purpose: it is the single source of truth
 * for the wrap/unwrap/span-shift semantics that both the in-app `biome`
 * command (`biome-command.ts`, WASM path) and the standalone `biome-jsh`
 * CLI (`packages/dev-tools/biome-jsh/`, binary path) rely on. The CLI ships
 * a byte-aligned plain-JS mirror (`jsh-biome-source.mjs`) so it stays
 * self-contained and publishable without a `@slicc/*` dependency; keep the
 * two in sync when either changes.
 */

const LINTABLE_EXTENSIONS = new Set([
  'js',
  'mjs',
  'cjs',
  'jsx',
  'ts',
  'mts',
  'cts',
  'tsx',
  'json',
  'jsonc',
  'css',
  'graphql',
  'gql',
  'html',
  'svelte',
  'vue',
  'astro',
  'jsh',
  'bsh',
]);

export function isLintableFile(path: string): boolean {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return false;
  return LINTABLE_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

/**
 * Map a real VFS path to a virtual path Biome can parse. `.jsh`
 * scripts and `.bsh` browser helpers both run as an AsyncFunction
 * body (see {@link wrapJshForBiome}), so their content is wrapped
 * before Biome sees it and a plain `.js` parser path is correct for
 * both. Everything else is returned unchanged. The real path is
 * always preserved by the caller for write-back and diagnostics;
 * this only picks Biome's parser.
 */
export function biomeVirtualPath(realPath: string): string {
  if (realPath.endsWith('.jsh')) return `${realPath.slice(0, -'.jsh'.length)}.js`;
  if (realPath.endsWith('.bsh')) return `${realPath.slice(0, -'.bsh'.length)}.js`;
  return realPath;
}

/**
 * Wrapper that gives a `.jsh`/`.bsh` body the same AsyncFunction
 * semantics Biome must parse it under. The `jsh` executor runs each
 * script as `new AsyncFunction(...names, body)` (see
 * `kernel/realm/realm-module-system.ts`; `.bsh` uses the same executor),
 * so top-level `await` AND top-level `return` are both valid there.
 * Without the wrapper Biome maps these files to a module and emits a
 * bogus "return outside of function" parse error (PR #1405 Codex P2).
 *
 * The body is placed at column 0 on its own lines — the prefix ends
 * in a newline and adds no indentation — so a diagnostic's column is
 * identical to the real file's column and only its byte offset shifts
 * by the prefix length (see {@link shiftBiomeSpans}).
 */
export const JSH_WRAP_PREFIX = 'async function __slicc() {\n';
export const JSH_WRAP_SUFFIX = '\n}';

/**
 * UTF-8 byte length of {@link JSH_WRAP_PREFIX}. Biome diagnostic spans
 * are byte offsets, so a wrapped-source span maps back to the real
 * source by subtracting this.
 */
export const JSH_WRAP_PREFIX_BYTE_LENGTH = new TextEncoder().encode(JSH_WRAP_PREFIX).length;

/** Wrap a `.jsh`/`.bsh` body for Biome. Inverse: {@link unwrapFormattedJsh}. */
export function wrapJshForBiome(source: string): string {
  return JSH_WRAP_PREFIX + source + JSH_WRAP_SUFFIX;
}

/** True when `realPath` is a SLICC shell script whose body needs the
 * AsyncFunction wrapper before Biome can parse it. */
export function shouldWrapForBiome(realPath: string): boolean {
  return realPath.endsWith('.jsh') || realPath.endsWith('.bsh');
}

/**
 * Recursively shift every Biome diagnostic byte `span` back by `delta`
 * (clamped ≥ 0) so diagnostics computed on the wrapped source render
 * against the ORIGINAL file. Also nulls any embedded `sourceCode`
 * string so `printDiagnostics({ fileSource })` frames the real source
 * rather than the wrapped copy. Mutates `root` in place. Iterative (no
 * self-reference) so it survives verbatim embedding.
 *
 * NOTE: embedded into the biome-command helper script via `.toString()` —
 * keep it self-contained (globals only, no closure over module scope).
 */
export function shiftBiomeSpans(root: unknown, delta: number): void {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
      continue;
    }
    const obj = node as Record<string, unknown>;
    const span = obj.span;
    if (
      Array.isArray(span) &&
      span.length === 2 &&
      typeof span[0] === 'number' &&
      typeof span[1] === 'number'
    ) {
      obj.span = [Math.max(0, span[0] - delta), Math.max(0, span[1] - delta)];
    }
    if (typeof obj.sourceCode === 'string') obj.sourceCode = null;
    for (const key of Object.keys(obj)) {
      if (key === 'span' || key === 'sourceCode') continue;
      stack.push(obj[key]);
    }
  }
}

/**
 * Strip the async-function wrapper Biome added around a formatted
 * `.jsh`/`.bsh` body: drop the first line (`async function __slicc() {`)
 * and the last line (`}`), then remove exactly one leading TAB (Biome's
 * default indent unit) from each remaining line. A trailing newline is
 * always emitted (Biome-formatted output ends in one).
 *
 * This de-indent is NOT lossless for multi-line template literals whose
 * continuation lines start with a real tab — Biome preserves those
 * verbatim, so stripping a leading tab would corrupt them. Callers MUST
 * guard the result with a re-format round-trip (see the helper) and fall
 * back to the original content when it does not reproduce the formatted
 * wrapped output.
 *
 * NOTE: embedded into the biome-command helper script via `.toString()` —
 * keep it self-contained (globals only, no closure over module scope).
 */
export function unwrapFormattedJsh(formatted: string): string {
  const trimmed = formatted.endsWith('\n') ? formatted.slice(0, -1) : formatted;
  const lines = trimmed.split('\n');
  lines.shift();
  lines.pop();
  const body = lines.map((line) => (line.startsWith('\t') ? line.slice(1) : line));
  return body.join('\n') + '\n';
}
