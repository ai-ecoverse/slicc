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

export function isLintableFile(path) {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return false;
  return LINTABLE_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

export function biomeVirtualPath(realPath) {
  if (realPath.endsWith('.jsh')) return `${realPath.slice(0, -'.jsh'.length)}.js`;
  if (realPath.endsWith('.bsh')) return `${realPath.slice(0, -'.bsh'.length)}.js`;
  return realPath;
}

export const JSH_WRAP_PREFIX = 'async function __slicc() {\n';
export const JSH_WRAP_SUFFIX = '\n}';

export const JSH_WRAP_PREFIX_BYTE_LENGTH = new TextEncoder().encode(JSH_WRAP_PREFIX).length;

export const JSH_WRAP_PREFIX_LINE_COUNT = (JSH_WRAP_PREFIX.match(/\n/g) || []).length;

export function wrapJshForBiome(source) {
  return JSH_WRAP_PREFIX + source + JSH_WRAP_SUFFIX;
}

export function shouldWrapForBiome(realPath) {
  return realPath.endsWith('.jsh') || realPath.endsWith('.bsh');
}

export function unwrapFormattedJsh(formatted) {
  const trimmed = formatted.endsWith('\n') ? formatted.slice(0, -1) : formatted;
  const lines = trimmed.split('\n');
  lines.shift();
  lines.pop();
  const body = lines.map((line) => (line.startsWith('\t') ? line.slice(1) : line));
  return body.join('\n') + '\n';
}
