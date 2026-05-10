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

export function resolvePinnedPackageVersion(packageName: string, versionSpec: unknown): string {
  if (typeof versionSpec !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(versionSpec)) {
    throw new Error(`${packageName} must use an exact semver version in package.json`);
  }
  return versionSpec;
}

export const NODE_VERSION = 'v20.0.0-js-shim';

let sqlJsPromise: Promise<SqlJsModule> | null = null;

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
