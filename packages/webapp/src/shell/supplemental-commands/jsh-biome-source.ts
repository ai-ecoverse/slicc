type BiomeDiagnosticJsonNode = {
  span?: unknown;
  sourceCode?: unknown;
  [key: string]: unknown;
};

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

export function biomeVirtualPath(realPath: string): string {
  if (realPath.endsWith('.jsh')) return `${realPath.slice(0, -'.jsh'.length)}.js`;
  if (realPath.endsWith('.bsh')) return `${realPath.slice(0, -'.bsh'.length)}.js`;
  return realPath;
}

export const JSH_WRAP_PREFIX = 'async function __slicc() {\n';
export const JSH_WRAP_SUFFIX = '\n}';

export const JSH_WRAP_PREFIX_BYTE_LENGTH = new TextEncoder().encode(JSH_WRAP_PREFIX).length;

export function wrapJshForBiome(source: string): string {
  return JSH_WRAP_PREFIX + source + JSH_WRAP_SUFFIX;
}

export function shouldWrapForBiome(realPath: string): boolean {
  return realPath.endsWith('.jsh') || realPath.endsWith('.bsh');
}

export function shiftBiomeSpans(root: unknown, delta: number): void {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
      continue;
    }
    const obj = node as BiomeDiagnosticJsonNode;
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

export function unwrapFormattedJsh(formatted: string): string {
  const trimmed = formatted.endsWith('\n') ? formatted.slice(0, -1) : formatted;
  const lines = trimmed.split('\n');
  lines.shift();
  lines.pop();
  const body = lines.map((line) => (line.startsWith('\t') ? line.slice(1) : line));
  return body.join('\n') + '\n';
}
