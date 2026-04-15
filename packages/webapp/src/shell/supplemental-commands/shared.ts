import type { PyodideInterface } from 'pyodide';
import { getMimeType } from '../../core/mime-types.js';
import { normalizePath } from '../../fs/path-utils.js';

export interface SqlJsResultSet {
  columns: string[];
  values: unknown[][];
}

export interface SqlJsDatabase {
  exec(sql: string): SqlJsResultSet[];
  export(): Uint8Array;
  close(): void;
}

export interface SqlJsModule {
  Database: new (data?: Uint8Array) => SqlJsDatabase;
}

type InitSqlJs = (options?: { locateFile?: (file: string) => string }) => Promise<SqlJsModule>;

const SQLJS_WASM_CDN = 'https://sql.js.org/dist/';
const PYODIDE_CDN = 'https://cdn.jsdelivr.net/pyodide/v0.27.7/full/';

export const NODE_VERSION = 'v20.0.0-js-shim';

export const PYTHON_RUNNER = `
import sys
import traceback

__slicc_exit_code = 0
try:
    sys.argv = __slicc_argv
    exec(compile(__slicc_code, __slicc_filename, "exec"), {"__name__": "__main__", "__file__": __slicc_filename})
except SystemExit as exc:
    code = exc.code
    if code is None:
        __slicc_exit_code = 0
    elif isinstance(code, int):
        __slicc_exit_code = code
    else:
        print(code, file=sys.stderr)
        __slicc_exit_code = 1
except BaseException:
    traceback.print_exc()
    __slicc_exit_code = 1
`;

let sqlJsPromise: Promise<SqlJsModule> | null = null;
let pyodidePromise: Promise<PyodideInterface> | null = null;

export const nodeRuntimeState: Record<string, unknown> = Object.create(null);

export class NodeExitError extends Error {
  constructor(public readonly code: number) {
    super(`Process exited with code ${code}`);
    this.name = 'NodeExitError';
  }
}

export function basename(path: string): string {
  const trimmed = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  const slash = trimmed.lastIndexOf('/');
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

export function dirname(path: string): string {
  const slash = path.lastIndexOf('/');
  if (slash <= 0) return '/';
  return path.slice(0, slash);
}

export function joinPath(base: string, child: string): string {
  if (base === '/') return `/${child}`;
  return `${base}/${child}`;
}

export function isLikelyUrl(value: string): boolean {
  if (/^(https?:\/\/|about:|file:|chrome:)/i.test(value)) return true;
  try {
    const parsed = new URL(value);
    return parsed.protocol.length > 0;
  } catch {
    return false;
  }
}

export function ensureWithinRoot(root: string, path: string): boolean {
  if (root === '/') return path.startsWith('/');
  return path === root || path.startsWith(`${root}/`);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function formatSqlValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Uint8Array) return `x'${toHex(value)}'`;
  return String(value);
}

export function detectMimeType(path: string): string {
  return getMimeType(path);
}

export function toPreviewUrl(vfsPath: string): string {
  const isExt = typeof chrome !== 'undefined' && !!chrome?.runtime?.id;
  const previewPath = `/preview${vfsPath}`;
  if (isExt) return chrome.runtime.getURL(previewPath);
  // Use current origin when in browser, fall back to default port for tests/Node
  const origin =
    typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : 'http://localhost:5710';
  return `${origin}${previewPath}`;
}

export function isSafeServeEntry(entry: string): boolean {
  if (entry.length === 0 || entry.startsWith('/')) return false;
  return !entry.split('/').some((segment) => segment === '..');
}

export function resolveServeEntryPath(directory: string, entry: string): string {
  return normalizePath(`${directory}/${entry}`);
}

export function formatConsoleArg(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function resolveNodePackageBaseUrl(specifier: string, fallbackRelativePath: string): URL {
  const resolver = (import.meta as ImportMeta & { resolve?: (value: string) => string }).resolve;
  if (typeof resolver === 'function') {
    try {
      return new URL('./', resolver(specifier));
    } catch {
      // Vitest's module runner exposes import.meta.resolve but does not implement it.
    }
  }
  return new URL(fallbackRelativePath, import.meta.url);
}

export async function getSqlJs(): Promise<SqlJsModule> {
  if (!sqlJsPromise) {
    sqlJsPromise = (async () => {
      const sqlModule = await import('sql.js/dist/sql-wasm.js');
      const initSqlJs = (sqlModule as { default: InitSqlJs }).default;
      const wasmBase =
        typeof window === 'undefined'
          ? resolveNodePackageBaseUrl(
              'sql.js/dist/sql-wasm.js',
              '../../../../../node_modules/sql.js/dist/'
            ).toString()
          : SQLJS_WASM_CDN;
      return initSqlJs({ locateFile: (file) => `${wasmBase}${file}` });
    })();
  }
  return sqlJsPromise;
}

const isExtension = typeof chrome !== 'undefined' && !!chrome?.runtime?.id;

/**
 * Replace comments and string literals in source code with whitespace so that
 * regex-based scanners don't produce false positives on code inside strings or
 * comments.  Block comments, line comments, template literals, and single/double
 * quoted strings are all handled.  Newlines inside replaced regions are
 * preserved so line-based position information stays roughly correct.
 */
export function stripCommentsAndStrings(code: string): string {
  return code.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g,
    (match) => match.replace(/[^\n]/g, ' ')
  );
}

/**
 * Strip only comments (block and line) while leaving string literals intact.
 * This is the right pre-processing step for import detection because the import
 * specifier itself lives inside a string literal that we need to match.
 */
function stripComments(code: string): string {
  // Process the code character-by-character to correctly distinguish comments
  // from string literals containing // or /*.  We walk through strings without
  // touching them, and blank out comments while preserving newlines.
  return code.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g,
    (match) => {
      // If the match starts with a quote character it's a string literal — keep it.
      if (match[0] === '"' || match[0] === "'" || match[0] === '`') return match;
      // Otherwise it's a comment — replace non-newline chars with spaces.
      return match.replace(/[^\n]/g, ' ');
    }
  );
}

/**
 * Returns true when `code` contains at least one static ESM `import` statement.
 *
 * Detects:
 * - `import foo from 'bar'`
 * - `import { a, b } from 'bar'`
 * - `import * as foo from 'bar'`
 * - `import 'bar'` (side-effect import)
 *
 * Does NOT match:
 * - `await import('bar')` (dynamic import)
 * - `require('bar')`
 * - Imports that appear only inside comments or string literals
 */
export function hasESMImports(code: string): boolean {
  const cleaned = stripComments(code);
  // Match static import statements using multiline mode so ^ matches each line.
  // Two patterns:
  //   1. import <bindings> from '<specifier>'
  //   2. import '<specifier>'  (side-effect)
  // The (?:^|;) prefix ensures we're at a statement boundary, not inside
  // `await import(...)`.
  const bindingImportRe = /(?:^|;)\s*import\s+(?:[\w$*{][^'"]*)\s+from\s+['"]/m;
  const sideEffectImportRe = /(?:^|;)\s*import\s+['"]/m;
  return bindingImportRe.test(cleaned) || sideEffectImportRe.test(cleaned);
}

/**
 * Extracts and deduplicates the module specifier strings from all static ESM
 * `import` statements in `code`.  Returns an empty array when no imports are
 * found.
 */
export function extractImportSpecifiers(code: string): string[] {
  const cleaned = stripComments(code);
  const specifiers: string[] = [];
  // Two global regexes: one for binding imports, one for side-effect imports.
  // Both use multiline mode so ^ anchors to line starts.
  const bindingRe = /(?:^|;)\s*import\s+(?:[\w$*{][^'"]*)\s+from\s+['"]([^'"]+)['"]/gm;
  const sideEffectRe = /(?:^|;)\s*import\s+['"]([^'"]+)['"]/gm;
  let m: RegExpExecArray | null;
  while ((m = bindingRe.exec(cleaned)) !== null) {
    const spec = m[1];
    if (spec && !specifiers.includes(spec)) {
      specifiers.push(spec);
    }
  }
  while ((m = sideEffectRe.exec(cleaned)) !== null) {
    const spec = m[1];
    if (spec && !specifiers.includes(spec)) {
      specifiers.push(spec);
    }
  }
  return specifiers;
}

export async function getPyodide(): Promise<PyodideInterface> {
  if (!pyodidePromise) {
    pyodidePromise = (async () => {
      const { loadPyodide } = await import('pyodide');
      let indexURL: string;
      if (typeof window === 'undefined') {
        indexURL = decodeURIComponent(
          resolveNodePackageBaseUrl('pyodide/pyodide.mjs', '../../../../../node_modules/pyodide/')
            .pathname
        );
      } else if (isExtension) {
        indexURL = chrome.runtime.getURL('pyodide/');
      } else {
        indexURL = PYODIDE_CDN;
      }
      return loadPyodide({ indexURL, fullStdLib: false });
    })();
  }
  return pyodidePromise;
}
