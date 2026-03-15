import { loadPyodide } from 'pyodide';
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
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
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
  const origin = (typeof window !== 'undefined' && window.location?.origin) || 'http://localhost:3000';
  return isExt ? chrome.runtime.getURL(previewPath) : `${origin}${previewPath}`;
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

export async function getSqlJs(): Promise<SqlJsModule> {
  if (!sqlJsPromise) {
    sqlJsPromise = (async () => {
      const sqlModule = await import('sql.js/dist/sql-wasm.js');
      const initSqlJs = (sqlModule as { default: InitSqlJs }).default;
      const wasmBase = typeof window === 'undefined'
        ? new URL('../../../node_modules/sql.js/dist/', import.meta.url).toString()
        : SQLJS_WASM_CDN;
      return initSqlJs({ locateFile: (file) => `${wasmBase}${file}` });
    })();
  }
  return sqlJsPromise;
}

const isExtension = typeof chrome !== 'undefined' && !!chrome?.runtime?.id;

export async function getPyodide(): Promise<PyodideInterface> {
  if (!pyodidePromise) {
    pyodidePromise = (async () => {
      let indexURL: string;
      if (typeof window === 'undefined') {
        indexURL = decodeURIComponent(new URL('../../../node_modules/pyodide/', import.meta.url).pathname);
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
