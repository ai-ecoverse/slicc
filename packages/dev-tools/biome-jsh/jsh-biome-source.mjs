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

/**
 * Split a leading shebang off a `.jsh`/`.bsh` source so it can be hoisted
 * above the wrapper. Biome accepts a hashbang only at the very start of a
 * file, never inside the `async function __slicc() {` body, while every jsh
 * runtime accepts one (the SLICC executor strips it via `strip-shebang.ts`).
 *
 * Only a `#!` on the very FIRST line counts, as in `strip-shebang.ts`.
 * `header` is that line plus any blank lines right after it, always ending
 * in a newline (one is added when the file is nothing but a shebang); `body`
 * is the rest, verbatim. With no shebang, `header` is `''` and `body` is the
 * whole source. `header` is never put inside the wrapper, so every body line
 * still shifts by exactly one line and {@link JSH_WRAP_PREFIX_BYTE_LENGTH}
 * bytes, and Biome formats the header like a plain `.js` hashbang (it keeps
 * at most one blank line after it).
 *
 * NOTE: embedded into the biome-command helper script via `.toString()` —
 * keep it self-contained (globals only, no closure over module scope).
 */
export function splitJshShebang(source) {
  if (!source.startsWith('#!')) return { header: '', body: source };
  const header = /^#![^\n]*(?:\n[ \t\r]*(?=\n))*\n?/.exec(source)?.[0] ?? source;
  const body = source.slice(header.length);
  return { header: header.endsWith('\n') ? header : `${header}\n`, body };
}

/**
 * Wrap a `.jsh`/`.bsh` body for Biome; a leading shebang (see
 * {@link splitJshShebang}) stays above the wrapper. Inverse:
 * {@link unwrapFormattedJsh}.
 */
export function wrapJshForBiome(source) {
  const { header, body } = splitJshShebang(source);
  return header + JSH_WRAP_PREFIX + body + JSH_WRAP_SUFFIX;
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
  // A hoisted shebang header (see splitJshShebang) sits above the wrapper:
  // keep the `#!` line and the blank lines after it verbatim.
  let headerLength = 0;
  if (lines.length > 0 && lines[0].startsWith('#!')) {
    headerLength = 1;
    while (headerLength < lines.length && lines[headerLength].trim() === '') headerLength++;
  }
  const header = lines.splice(0, headerLength);
  lines.shift();
  lines.pop();
  const body = lines.map((line) => (line.startsWith('\t') ? line.slice(1) : line));
  return header.concat(body).join('\n') + '\n';
}
