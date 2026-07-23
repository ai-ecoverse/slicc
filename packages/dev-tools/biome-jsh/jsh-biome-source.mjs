/**
 * Pure, dependency-free helpers that make Biome lint/format `.jsh`/`.bsh`
 * shell scripts correctly. Self-contained so the `biome-jsh` CLI stays
 * standalone and publishable without a `@slicc/*` dependency.
 *
 * `.jsh` scripts and `.bsh` browser helpers run as an AsyncFunction body, so
 * top-level `await` AND top-level `return` are valid there. Biome's file-mode
 * parser maps a bare `.jsh`/`.bsh` body to a module and emits a bogus "return
 * outside of function" parse error, so the body is wrapped in an async
 * function before Biome sees it and the diagnostics are shifted back.
 *
 * This is a byte-aligned mirror of
 * `packages/webapp/src/shell/supplemental-commands/jsh-biome-source.ts`
 * (the in-app WASM path). Keep the two in sync when either changes.
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

/** True when `path` has an extension Biome (via this wrapper) can lint. */
export function isLintableFile(path) {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return false;
  return LINTABLE_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

/**
 * Map a real path to the virtual path Biome should parse it under. `.jsh`
 * and `.bsh` both wrap to an AsyncFunction body, so a plain `.js` parser
 * path is correct for both. Everything else is returned unchanged.
 */
export function biomeVirtualPath(realPath) {
  if (realPath.endsWith('.jsh')) return `${realPath.slice(0, -'.jsh'.length)}.js`;
  if (realPath.endsWith('.bsh')) return `${realPath.slice(0, -'.bsh'.length)}.js`;
  return realPath;
}

/**
 * Wrapper that gives a `.jsh`/`.bsh` body the same AsyncFunction semantics it
 * runs under, so top-level `await` and top-level `return` are both valid and
 * Biome does not emit a bogus "return outside of function" parse error.
 *
 * The body is placed at column 0 on its own lines — the prefix ends in a
 * newline and adds no indentation — so a diagnostic's column is identical to
 * the real file's column and only its line/byte offset shifts by the prefix.
 */
export const JSH_WRAP_PREFIX = 'async function __slicc() {\n';
export const JSH_WRAP_SUFFIX = '\n}';

/**
 * UTF-8 byte length of {@link JSH_WRAP_PREFIX}. Biome diagnostic spans are
 * byte offsets, so a wrapped-source span maps back by subtracting this.
 */
export const JSH_WRAP_PREFIX_BYTE_LENGTH = new TextEncoder().encode(JSH_WRAP_PREFIX).length;

/**
 * Number of newlines the prefix inserts ahead of the body. The `--reporter=github`
 * output is line/column based, so a diagnostic on the wrapped source maps back
 * to the real file by subtracting this from its `line`/`endLine`. Because the
 * prefix is exactly one newline-terminated line at column 0, this is the
 * line-space equivalent of subtracting {@link JSH_WRAP_PREFIX_BYTE_LENGTH}.
 */
export const JSH_WRAP_PREFIX_LINE_COUNT = (JSH_WRAP_PREFIX.match(/\n/g) || []).length;

/** Wrap a `.jsh`/`.bsh` body for Biome. Inverse: {@link unwrapFormattedJsh}. */
export function wrapJshForBiome(source) {
  return JSH_WRAP_PREFIX + source + JSH_WRAP_SUFFIX;
}

/** True when `realPath` is a shell script whose body needs the wrapper. */
export function shouldWrapForBiome(realPath) {
  return realPath.endsWith('.jsh') || realPath.endsWith('.bsh');
}

/**
 * Strip the async-function wrapper Biome added around a formatted
 * `.jsh`/`.bsh` body: drop the first line (`async function __slicc() {`) and
 * the last line (`}`), then remove exactly one leading TAB (Biome's default
 * indent unit) from each remaining line. A trailing newline is always emitted.
 *
 * This de-indent is NOT lossless for multi-line template literals whose
 * continuation lines start with a real tab — callers MUST guard the result
 * with a re-format round-trip and fall back to the original content when it
 * does not reproduce the formatted wrapped output.
 */
export function unwrapFormattedJsh(formatted) {
  const trimmed = formatted.endsWith('\n') ? formatted.slice(0, -1) : formatted;
  const lines = trimmed.split('\n');
  lines.shift();
  lines.pop();
  const body = lines.map((line) => (line.startsWith('\t') ? line.slice(1) : line));
  return body.join('\n') + '\n';
}
