import { getMimeType } from '../../core/mime-types.js';
import { normalizePath, splitPath } from '../../fs/path-utils.js';
import { resolve as ipkResolve, type ModuleReader } from '../ipk/resolver.js';

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

export type TypeScriptModule = typeof import('typescript');

export function resolvePinnedPackageVersion(packageName: string, versionSpec: unknown): string {
  if (typeof versionSpec !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(versionSpec)) {
    throw new Error(`${packageName} must use an exact semver version in package.json`);
  }
  return versionSpec;
}

export const NODE_VERSION = 'v20.0.0-js-shim';

let sqlJsPromise: Promise<SqlJsModule> | null = null;
let typeScriptPromise: Promise<TypeScriptModule> | null = null;

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
  // Preference: page realm (`window`) → worker realm (`self.location`) → Node/test fallback.
  // The kernel worker has no `window`, but its bundle is served from the UI origin, so
  // `self.location.origin` is the correct preview host there. In thin-bridge mode this
  // avoids pointing previews at the bridge origin (e.g. `http://localhost:5710`) instead
  // of the UI origin (e.g. `http://localhost:8787`).
  let origin = 'http://localhost:5710';
  if (typeof window !== 'undefined' && window.location?.origin) {
    origin = window.location.origin;
  } else if (typeof self !== 'undefined' && self.location?.origin) {
    origin = self.location.origin;
  }
  return `${origin}${previewPath}`;
}

/**
 * True for any preview-serving URL — both the legacy local SW path
 * (`<origin>/preview/<vfs-path>` or `chrome-extension://<id>/preview/...`)
 * and the unified worker path (`<token>.sliccy.dev` / `<token>.staging.sliccy.dev`).
 * Used by the app-tab detector to avoid identifying a preview tab as the SLICC app.
 */
export function isPreviewUrl(url: string): boolean {
  if (url.includes('/preview/')) return true;
  try {
    const host = new URL(url).host;
    return /^[^.]+\.sliccy\.(?:now|dev)$/i.test(host);
  } catch {
    return false;
  }
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

/**
 * True when running under Node.js (vitest, build tooling). Use this
 * instead of `typeof window === 'undefined'` to decide whether to
 * resolve WASM assets via local `node_modules` — a DedicatedWorker
 * has no `window` either, and that branch breaks browser/CLI mode.
 */
export function isNodeRuntime(): boolean {
  return (
    typeof process !== 'undefined' && !!(process as { versions?: { node?: string } }).versions?.node
  );
}

/**
 * True when running inside a Chrome extension (page, offscreen, SW,
 * or extension-spawned DedicatedWorker — `chrome.runtime.id` is
 * present everywhere in the extension origin).
 */
export function isExtensionRuntime(): boolean {
  return (
    typeof chrome !== 'undefined' &&
    !!(chrome as { runtime?: { id?: string } } | undefined)?.runtime?.id
  );
}

export async function getSqlJs(): Promise<SqlJsModule> {
  if (!sqlJsPromise) {
    sqlJsPromise = (async () => {
      const sqlModule = await import('sql.js/dist/sql-wasm.js');
      const initSqlJs = (sqlModule as { default: InitSqlJs }).default;
      const wasmBase = isNodeRuntime()
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

/**
 * Read-only VFS context the loader needs to read an ipk-installed
 * `typescript` from the VFS `node_modules`. Mirrors the
 * `IpkResolutionContext` shape used by `esbuild-wasm.ts` and
 * `biome-command.ts` so every float (standalone/hosted/extension/Node)
 * wires it the same way. `readBytes` is unused for typescript (the
 * package is pure JS) but kept on the shape to match the canonical
 * interface — callers can pass the same object they build for biome
 * or esbuild.
 */
export interface TypeScriptIpkContext {
  reader: ModuleReader;
  readBytes?(absolutePath: string): Promise<Uint8Array>;
  fromDir: string;
}

const TYPESCRIPT_NOT_INSTALLED =
  'typescript is not installed in node_modules: run `ipk add typescript` (no network fallback)';

/**
 * Lazy singleton for the `typescript` package. Pure JS (no WASM init).
 *
 * Node runtime (vitest, build tooling): falls back to the
 * locally-installed `typescript` npm dependency via dynamic
 * `import('typescript')`. The `/* @vite-ignore *\/` comment keeps the
 * heavy module OUT of the browser bundle while leaving the Node path
 * functional for tests and the realm host's transpile fallback.
 *
 * Browser runtime (standalone OR extension): reads the
 * ipk-installed `typescript/lib/typescript.js` from VFS `node_modules`
 * via the shared resolver, evaluates the CJS source in a fresh
 * `new Function('module', 'exports', source)` wrapper, and returns
 * the captured `module.exports` as the `ts` API surface. No CDN
 * fallback — a missing package surfaces the canonical guidance error
 * which the calling command surfaces verbatim. Shared with `test` so a
 * single transpiler instance powers both `tsc` and `.ts` test files.
 */
export async function getTypeScript(ipk?: TypeScriptIpkContext): Promise<TypeScriptModule> {
  if (!typeScriptPromise) {
    typeScriptPromise = loadTypeScript(ipk).catch((err) => {
      typeScriptPromise = null;
      throw err;
    });
  }
  return typeScriptPromise;
}

async function loadTypeScript(ipk?: TypeScriptIpkContext): Promise<TypeScriptModule> {
  if (isNodeRuntime()) {
    // `/* @vite-ignore */` keeps `typescript` out of the browser bundle
    // while Node (vitest/build tooling) still resolves it from local
    // node_modules at runtime.
    const mod = await import(/* @vite-ignore */ 'typescript');
    return ((mod as { default?: TypeScriptModule }).default ?? mod) as TypeScriptModule;
  }
  if (!ipk) throw new Error(TYPESCRIPT_NOT_INSTALLED);
  const source = await tryLoadTypeScriptSourceFromNodeModules(ipk);
  if (source === null) throw new Error(TYPESCRIPT_NOT_INSTALLED);
  return evaluateTypeScriptModule(source);
}

/**
 * Try to read `typescript/lib/typescript.js` source from an ipk-installed
 * `typescript` in the VFS. Returns `null` on any resolution / read miss
 * so the caller surfaces the canonical guidance error. Exported so the
 * loader's resolution behavior is unit-testable without booting the
 * heavy compiler.
 */
export async function tryLoadTypeScriptSourceFromNodeModules(
  ipk: TypeScriptIpkContext
): Promise<string | null> {
  let resolved;
  try {
    resolved = await ipkResolve('typescript/package.json', ipk.fromDir, ipk.reader);
  } catch {
    return null;
  }
  if (resolved.type !== 'file') return null;
  const pkgDir = splitPath(resolved.path).dir;
  const entryPath = `${pkgDir}/lib/typescript.js`;
  if (!(await ipk.reader.exists(entryPath))) return null;
  try {
    return await ipk.reader.readFile(entryPath);
  } catch {
    return null;
  }
}

/**
 * Evaluate the bundled `typescript/lib/typescript.js` UMD source as a
 * CommonJS module and return its `module.exports`. The TypeScript
 * distribution detects `module.exports` at top level and writes its
 * full API surface onto it, so a bare `new Function('module',
 * 'exports', source)` wrapper recovers the same shape as a Node
 * `require('typescript')` call. Same trust boundary as the realm CJS
 * evaluator in `module-loader.ts`.
 */
function evaluateTypeScriptModule(source: string): TypeScriptModule {
  const module: { exports: Record<string, unknown> } = { exports: {} };
  // biome-ignore lint/security/noGlobalEval: typescript.js is the
  // ipk-installed package source — same trust boundary as the realm
  // CJS evaluator in `module-loader.ts`.
  const evaluator = new Function('module', 'exports', source);
  evaluator(module, module.exports);
  return module.exports as unknown as TypeScriptModule;
}

/**
 * Drop the cached typescript promise so the next `getTypeScript`
 * call rebuilds from scratch. Test-only — production callers share
 * the single loaded instance for the lifetime of the realm.
 */
export function resetTypeScriptForTests(): void {
  typeScriptPromise = null;
}
