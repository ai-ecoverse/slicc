import type { CommandContext } from 'just-bash';
import { getMimeType } from '../../base/mime-types.js';
import { isExtensionRealm } from '../../base/runtime-env.js';
import { normalizePath, splitPath } from '../../fs/path-utils.js';
import { NODE_SHIM_VERSION } from '../../kernel/realm/node-builtins.js';
import {
  resolve as ipkResolve,
  type ModuleReader,
  nodeModulesSearchPath,
} from '../ipk/resolver.js';

// `/preview/*` URL construction lives in `base/` so the chat message renderer can
// use it without importing this module (and with it `just-bash` + the ipk
// resolver) onto the boot path. Re-exported here for existing shell callers.
export { isPreviewUrl, toPreviewUrl } from '../../base/preview-url.js';

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

export type TypeScriptModule = typeof import('typescript-js');

/** Canonical global install prefix for CLI-tool bootstrap hints. */
export const GLOBAL_IPK_ADD = 'ipk add -g';

export const TYPESCRIPT_PINNED_SPEC = 'typescript@6.0.3';

/** Fresh install when nothing resolves (shadow map, `--help`, not-installed). */
export const TYPESCRIPT_VFS_INSTALL_COMMAND = `${GLOBAL_IPK_ADD} ${TYPESCRIPT_PINNED_SPEC}`;

/** Replace a cwd-local copy that shadows global installs (wrong major/version). */
export const TYPESCRIPT_VFS_REPLACE_COMMAND = `run \`ipk uninstall typescript\` then \`ipk add ${TYPESCRIPT_PINNED_SPEC}\``;

export function resolvePinnedPackageVersion(packageName: string, versionSpec: unknown): string {
  if (typeof versionSpec !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(versionSpec)) {
    throw new Error(`${packageName} must use an exact semver version in package.json`);
  }
  return versionSpec;
}

/**
 * `node --version` output. Carries the `-js-shim` marker so a user can tell
 * this is not a real Node, while the realm's `process.version` /
 * `process.versions.node` stay plain and parseable (see
 * {@link NODE_SHIM_VERSION}) because dependencies split them numerically.
 */
export const NODE_VERSION = `v${NODE_SHIM_VERSION}-js-shim`;

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

/**
 * Marker files that identify the containing directory as a project root
 * whose framework expects to be served from `/` (EDS, or any app with a
 * `package.json`/`.git` checkout). Checked in order; first hit wins.
 */
const PROJECT_ROOT_MARKERS = ['head.html', 'fstab.yaml', 'package.json', '.git'];

/**
 * Walk upward from `startDir` looking for a project-root marker file.
 * Falls back to `startDir` itself when none is found before VFS root —
 * still an improvement over the VFS root default, since root-absolute
 * sibling paths then resolve against the file's own directory instead
 * of `/`. Mirrors `findTsconfigPath` (`tsc-command.ts`)'s walk-up shape.
 */
export async function findProjectRoot(fs: CommandContext['fs'], startDir: string): Promise<string> {
  let dir = startDir || '/';
  let lastDir = '';
  while (dir && dir !== lastDir) {
    for (const marker of PROJECT_ROOT_MARKERS) {
      const candidate = dir === '/' ? `/${marker}` : `${dir}/${marker}`;
      if (await fs.exists(candidate)) return dir;
    }
    lastDir = dir;
    dir = dirname(dir);
  }
  return startDir;
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
  return isExtensionRealm();
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
 * `typescript@6.0.3` from the VFS `node_modules`. Mirrors the
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
  `TypeScript 6 is not installed in node_modules: run \`${TYPESCRIPT_VFS_INSTALL_COMMAND}\` ` +
  '(no network fallback)';

/**
 * Explain a browser-branch TypeScript miss in terms of what was actually
 * found. Three shapes, because "not installed" is misleading in two of them
 * (#2200):
 *
 *  - nothing resolved -> name the `node_modules` directories walked, since
 *    resolution starts at the command's cwd and a package installed
 *    elsewhere is genuinely invisible;
 *  - a `typescript` whose major is not 6 -> name the version and say why it
 *    cannot serve (TypeScript 7 is the native port: its npm package ships no
 *    JS compiler API, so `transpileModule` does not exist in the browser);
 *  - resolved TypeScript 6 without a readable `lib/typescript.js` -> the
 *    canonical install guidance.
 *
 * The pin stays at 6.0.3 deliberately (#1658); a workspace on 7.x has to
 * install the 6 line into a directory the command's cwd can see.
 */
async function describeTypeScriptMiss(ipk: TypeScriptIpkContext): Promise<string> {
  let manifest: string | null = null;
  let manifestPath: string | null = null;
  try {
    const resolved = await ipkResolve('typescript/package.json', ipk.fromDir, ipk.reader);
    if (resolved.type === 'file') {
      manifestPath = resolved.path;
      manifest = await ipk.reader.readFile(resolved.path);
    }
  } catch {
    manifest = null;
  }
  if (manifest === null || manifestPath === null) {
    return (
      `TypeScript 6 is not installed in node_modules: run \`${TYPESCRIPT_VFS_INSTALL_COMMAND}\` ` +
      `(no network fallback; searched from ${ipk.fromDir}: ` +
      `${nodeModulesSearchPath(ipk.fromDir).join(', ')})`
    );
  }
  let version: unknown;
  try {
    version = (JSON.parse(manifest) as { version?: unknown }).version;
  } catch {
    version = undefined;
  }
  const major = typeof version === 'string' ? Number.parseInt(version, 10) : Number.NaN;
  if (Number.isFinite(major) && major !== 6) {
    // Only the native port (7+) dropped `lib/typescript.js`; older majors do
    // ship the JS compiler API and are refused solely by the pin.
    const why =
      major > 6
        ? 'which ships no JS compiler API for the browser (no `lib/typescript.js`, so no `transpileModule`)'
        : 'which predates the pinned 6.x line this build loads';
    return (
      `TypeScript 6 is required but ${splitPath(manifestPath).dir} holds typescript@${String(version)}, ` +
      `${why}: ${TYPESCRIPT_VFS_REPLACE_COMMAND} to replace the local copy ` +
      '(cwd-local node_modules is searched before global; `ipk add -g` will not override it)'
    );
  }
  return TYPESCRIPT_NOT_INSTALLED;
}

/**
 * Lazy singleton for the classic TypeScript JS compiler API. Pure JS (no WASM init).
 *
 * Node runtime (vitest, build tooling): falls back to the
 * locally-installed `typescript-js` npm alias via dynamic
 * `import('typescript-js')`. The `/* @vite-ignore *\/` comment keeps the
 * heavy module OUT of the browser bundle while leaving the Node path
 * functional for tests and the realm host's transpile fallback.
 *
 * Browser runtime (standalone OR extension): reads the
 * ipk-installed `typescript@6.0.3` compiler from
 * `typescript/lib/typescript.js` in VFS `node_modules`
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
    // `/* @vite-ignore */` keeps `typescript-js` out of the browser bundle
    // while Node (vitest/build tooling) still resolves it from local
    // node_modules at runtime.
    const mod = await import(/* @vite-ignore */ 'typescript-js');
    return ((mod as { default?: TypeScriptModule }).default ?? mod) as TypeScriptModule;
  }
  if (!ipk) throw new Error(TYPESCRIPT_NOT_INSTALLED);
  const source = await tryLoadTypeScriptSourceFromNodeModules(ipk);
  if (source === null) throw new Error(await describeTypeScriptMiss(ipk));
  return evaluateTypeScriptModule(source);
}

/**
 * Try to read `typescript/lib/typescript.js` source from an ipk-installed
 * TypeScript 6 package in the VFS. Returns `null` on any resolution / read miss
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
  // biome-ignore lint/plugin: the TypeScript UMD bundle writes its own API surface onto `module.exports`; the shape is the compiler's (narrowed to `TypeScriptModule` on return), not ours to name.
  const module: { exports: Record<string, unknown> } = { exports: {} };
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
