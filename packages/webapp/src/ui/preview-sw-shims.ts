/**
 * Synthetic shim code generator for ESM built-in module imports.
 *
 * When scripts use `import { readFile } from 'fs'`, the import map resolves
 * `fs` to `/preview/__shims/fs.js`. The preview service worker intercepts
 * these requests and returns the JavaScript module code generated here,
 * which re-exports from `globalThis.__slicc_*` shim objects set up by
 * the execution engine.
 */

export const SHIMMED_BUILTINS = ['fs', 'process', 'buffer'] as const;

export const UNAVAILABLE_BUILTINS = [
  'http',
  'https',
  'net',
  'tls',
  'dgram',
  'dns',
  'cluster',
  'worker_threads',
  'child_process',
  'crypto',
  'os',
  'stream',
  'zlib',
  'vm',
  'v8',
  'perf_hooks',
  'readline',
  'repl',
  'tty',
  'inspector',
] as const;

const ALTERNATIVE_HINTS: Record<string, string> = {
  http: 'Use the fetch() API instead.',
  https: 'Use the fetch() API instead.',
  child_process: 'Use the bash tool or exec() shell command instead.',
  crypto: 'Use the Web Crypto API (globalThis.crypto) instead.',
  stream: 'Use Web Streams (ReadableStream/WritableStream) instead.',
  os: 'OS information is not available in the browser environment.',
  net: 'Direct TCP/UDP sockets are not available in the browser.',
  tls: 'Direct TLS sockets are not available in the browser. Use fetch() for HTTPS.',
  dns: 'DNS resolution is not available in the browser.',
  worker_threads: 'Use Web Workers instead.',
};

/**
 * Generate JavaScript module code for a given built-in module name.
 *
 * Returns the source text of a JS module that either:
 * - Re-exports from a `globalThis.__slicc_*` shim object (for shimmed builtins)
 * - Throws a helpful error (for unavailable builtins)
 * - Returns `null` (for unknown modules)
 */
export function generateShimCode(name: string): string | null {
  switch (name) {
    case 'fs':
      return [
        `const _fs = globalThis.__slicc_fs;`,
        `export const readFile = _fs.readFile;`,
        `export const readFileBinary = _fs.readFileBinary;`,
        `export const writeFile = _fs.writeFile;`,
        `export const writeFileBinary = _fs.writeFileBinary;`,
        `export const readDir = _fs.readDir;`,
        `export const exists = _fs.exists;`,
        `export const stat = _fs.stat;`,
        `export const mkdir = _fs.mkdir;`,
        `export const rm = _fs.rm;`,
        `export const fetchToFile = _fs.fetchToFile;`,
        `export default _fs;`,
      ].join('\n');

    case 'process':
      return [
        `const _process = globalThis.__slicc_process;`,
        `export const argv = _process.argv;`,
        `export const env = _process.env;`,
        `export const cwd = _process.cwd;`,
        `export const exit = _process.exit;`,
        `export const stdout = _process.stdout;`,
        `export const stderr = _process.stderr;`,
        `export default _process;`,
      ].join('\n');

    case 'buffer':
      return [
        `const _Buffer = globalThis.Buffer;`,
        `export const Buffer = _Buffer;`,
        `export default { Buffer: _Buffer };`,
      ].join('\n');

    default: {
      if ((UNAVAILABLE_BUILTINS as readonly string[]).includes(name)) {
        const hint = ALTERNATIVE_HINTS[name] ?? '';
        const hintSuffix = hint ? ` ${hint}` : '';
        return [
          `const msg = 'Module "${name}" is not available in the browser environment.${hintSuffix}';`,
          `throw new Error(msg);`,
        ].join('\n');
      }
      return null;
    }
  }
}
