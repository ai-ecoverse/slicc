/**
 * `realm-module-system.ts` — the realm's synchronous CJS module system over
 * a host-resolved module graph: `require()` shim, bare/`node:`/`sliccy:`
 * resolution, and the `AsyncFunction` user-code runner. Extracted from
 * `js-realm-shared.ts`; no behavior change.
 */
import {
  fmt,
  type NodeChildProcess,
  nodeAssert,
  nodeAssertStrict,
  nodeCrypto,
  nodeEvents,
  nodeOs,
  nodePath,
  nodeStream,
  nodeUrl,
  nodeUtil,
  nodeZlib,
  pool,
  time,
} from './js-realm-helpers.js';
import { NODE_BUILTINS_UNAVAILABLE } from './node-builtins.js';
import { createPlaywrightShim } from './playwright-shim.js';
import { dirnameOf, NodeExitError } from './realm-node-shims.js';
import type { RealmRpcClient } from './realm-rpc.js';
import type { RealmModuleGraph } from './realm-types.js';
import { NODE_NATIVE_PACKAGES, nativePackageError } from './require-guards.js';

const SLICCY_SCHEME = 'sliccy:';

export function buildSliccyModules(bridges: Record<string, unknown>): Record<string, unknown> {
  return { ...bridges, time, fmt, pool };
}

/**
 * The directory a script's top-level relative `require()`/`import`s resolve
 * against: the script's own directory for a real file path, else the realm cwd
 * (the `node -e` / `<eval>` case).
 */
function entryFromDir(filename: string, cwd: string): string {
  return filename?.startsWith('/') ? dirnameOf(filename) : cwd;
}

/**
 * Cheap pre-check: does the entry code reference any `require`/`import` at all?
 * When it does not, there is nothing for the host to resolve or transpile, so
 * the no-module fast path skips the `module`/buildGraph RPC entirely.
 */
function mightNeedModuleGraph(code: string): boolean {
  return code.includes('require') || code.includes('import');
}

/**
 * Build the host-resolved CJS module graph from the realm's ENTRY CODE via the
 * `module`/`buildGraph` RPC. The host extracts the entry's tagged
 * `require`/`import` specifiers, resolves them per access path, transpiles ESM
 * modules + the entry itself (`entrySource`), and returns the ordered graph.
 * Returns an empty graph (no RPC) when the entry references no module at all.
 */
export async function loadModuleGraph(
  rpc: RealmRpcClient,
  code: string,
  cwd: string,
  filename: string
): Promise<RealmModuleGraph> {
  if (!mightNeedModuleGraph(code)) return { files: [], entryMap: {}, edges: {}, errors: {} };
  return rpc.call<RealmModuleGraph>('module', 'buildGraph', [
    code,
    entryFromDir(filename, cwd),
    filename,
  ]);
}

/**
 * Node-faithful CJS default interop: `import def from 'cjs'` binds `def` to the
 * whole `module.exports` REGARDLESS of `__esModule`. Both transpilers honor a
 * Babel-style `__esModule` shim and read a real own `.default` (esbuild's
 * `__toESM` does not synthesize one when `__esModule` is truthy; TS's
 * `__importDefault` returns the module as-is), so a transpiled-CJS module that
 * sets `__esModule:true` but exposes no own `default` (e.g. uuid@9's
 * Babel-compiled `dist/index.js`) would bind `default` to `undefined`. Attach a
 * non-enumerable, configurable, self-referential `default` so esbuild's
 * `__copyProps` (own prop NAMES, incl. non-enumerable) and TS's `__importDefault`
 * both resolve `default` to the whole module. Non-enumerable keeps it invisible
 * to `Object.keys`/`JSON.stringify`; the extensibility guard + try/catch keep a
 * frozen/sealed exports object from throwing. Called ONLY for modules whose
 * origin kind is `cjs` (the `kindByPath` guard in `requireFile`): a
 * host-transpiled ESM module also carries `__esModule:true` with no own
 * `default` when its source declares none (e.g. nanoid@5), and synthesizing a
 * default there would wrongly make `require('nanoid').default` the whole
 * namespace instead of `undefined` (require-of-ESM is Node-faithful with no
 * default).
 */
function synthesizeEsModuleDefault(exp: unknown): void {
  if (exp === null || typeof exp !== 'object') return;
  const obj = exp as Record<string, unknown>;
  if (!obj.__esModule) return;
  if (Object.prototype.hasOwnProperty.call(obj, 'default')) return;
  if (!Object.isExtensible(obj)) return;
  try {
    Object.defineProperty(obj, 'default', { value: obj, enumerable: false, configurable: true });
  } catch {
    // Frozen/sealed exports: leave as-is (defineProperty would throw).
  }
}

/**
 * Bare-specifier packages the realm resolver serves in place of a real npm
 * install. `createPlaywrightShim(rpc)` is a Playwright-shaped API backed by
 * SLICC's existing CDP connection — see `playwright-shim.ts`. Consulted by
 * `resolveBuiltin` inside `createModuleSystem` after the node builtins /
 * native-package guards, so `require('playwright')` resolves here instead of
 * throwing "Cannot find module".
 */
export function buildShimmedPackages(rpc: RealmRpcClient): Record<string, unknown> {
  return {
    playwright: createPlaywrightShim(rpc),
  };
}

/**
 * Construct the realm's synchronous CJS module system over a preloaded graph.
 * `require` follows the host-resolved `edges`, lazily evaluating each module
 * once and caching `module.exports` so repeated requires return one shared
 * singleton (CJS cache semantics). Module evaluation is synchronous CJS via a
 * `Function` wrapper (Node's `Module._compile` shape). Schemes/built-ins are
 * served first; an unresolved bare specifier throws the install-hint error.
 */
export function createModuleSystem(opts: {
  graph: RealmModuleGraph;
  fsBridge: unknown;
  processShim: unknown;
  childProcess: NodeChildProcess;
  nodeConsole: unknown;
  sliccyModules: Record<string, unknown>;
  shimmedPackages?: Record<string, unknown>;
}): { require: (id: string) => unknown } {
  const {
    graph,
    fsBridge,
    processShim,
    childProcess,
    nodeConsole,
    sliccyModules,
    shimmedPackages = {},
  } = opts;
  const sourceByPath = new Map(graph.files.map((f) => [f.path, f.cjsSource]));
  const kindByPath = new Map(graph.files.map((f) => [f.path, f.kind]));
  const cache = new Map<string, { exports: Record<string, unknown> }>();

  const resolveBuiltin = (id: string): { hit: boolean; value?: unknown } => {
    if (typeof id === 'string' && id.startsWith(SLICCY_SCHEME)) {
      return { hit: true, value: resolveSliccyModule(id, sliccyModules) };
    }
    const bareId = id.startsWith('node:') ? id.slice(5) : id;
    const served = resolveServedBuiltin(bareId, fsBridge, processShim, childProcess);
    if (served.hit) return served;
    if (NODE_NATIVE_PACKAGES.has(bareId)) throw nativePackageError(id, bareId);
    if (NODE_BUILTINS_UNAVAILABLE.has(bareId)) throw unavailableBuiltinError(id, bareId);
    if (bareId in shimmedPackages) return { hit: true, value: shimmedPackages[bareId] };
    return { hit: false };
  };

  const requireFromEdges = (edgeMap: Record<string, string> | undefined, id: string): unknown => {
    const builtin = resolveBuiltin(id);
    if (builtin.hit) return builtin.value;
    const targetPath = edgeMap?.[id];
    if (targetPath) return requireFile(targetPath);
    if (id in graph.errors) throw new Error(graph.errors[id]);
    throw cannotFindModuleError(id);
  };

  function requireFile(path: string): Record<string, unknown> {
    const cached = cache.get(path);
    if (cached) return cached.exports;
    const source = sourceByPath.get(path);
    if (source === undefined) throw new Error(`Cannot find module '${path}'`);
    const moduleObj = { exports: {} as Record<string, unknown> };
    // Register before evaluation so a require cycle sees the partial exports.
    cache.set(path, moduleObj);
    const childRequire = (id: string): unknown => requireFromEdges(graph.edges[path], id);
    const moduleDir = dirnameOf(path);
    const compiled = new Function(
      'module',
      'exports',
      'require',
      '__dirname',
      '__filename',
      'process',
      'console',
      'Buffer',
      'global',
      source
    ) as (...args: unknown[]) => void;
    compiled(
      moduleObj,
      moduleObj.exports,
      childRequire,
      moduleDir,
      path,
      processShim,
      nodeConsole,
      (globalThis as Record<string, unknown>).Buffer,
      globalThis
    );
    if (kindByPath.get(path) === 'cjs') synthesizeEsModuleDefault(moduleObj.exports);
    return moduleObj.exports;
  }

  return {
    require: (id: string): unknown => requireFromEdges(graph.entryMap, id),
  };
}

/**
 * Build the Node `Cannot find module` error for a specifier with no graph
 * edge. Bare package specifiers carry the actionable `ipk install` hint;
 * relative/absolute/`node:` specifiers do not (matching the host resolver).
 */
/**
 * Resolve a bare (scheme-stripped) built-in id to the value the realm serves
 * for it, or `{ hit: false }` when the realm does not serve it directly.
 * Extracted from `resolveBuiltin` so the per-builtin `bareId === '…'` chain
 * stays a flat, low-complexity lookup (and the `node-command-loadmodule` /
 * `js-realm-helpers` parity tests keep matching the literal branches here).
 */
function resolveServedBuiltin(
  bareId: string,
  fsBridge: unknown,
  processShim: unknown,
  childProcess: NodeChildProcess
): { hit: boolean; value?: unknown } {
  if (bareId === 'fs') return { hit: true, value: fsBridge };
  // Same object — fsBridge is already Promise-based; callback/sync APIs are not shimmed here.
  if (bareId === 'fs/promises') return { hit: true, value: fsBridge };
  if (bareId === 'path') return { hit: true, value: nodePath };
  if (bareId === 'crypto') return { hit: true, value: nodeCrypto };
  if (bareId === 'child_process') return { hit: true, value: childProcess };
  if (bareId === 'process') return { hit: true, value: processShim };
  if (bareId === 'buffer') {
    return { hit: true, value: { Buffer: (globalThis as Record<string, unknown>).Buffer } };
  }
  if (bareId === 'assert') return { hit: true, value: nodeAssert };
  if (bareId === 'assert/strict') return { hit: true, value: nodeAssertStrict };
  if (bareId === 'util') return { hit: true, value: nodeUtil };
  if (bareId === 'events') return { hit: true, value: nodeEvents };
  if (bareId === 'os') return { hit: true, value: nodeOs };
  if (bareId === 'stream') return { hit: true, value: nodeStream };
  if (bareId === 'url') return { hit: true, value: nodeUrl };
  if (bareId === 'zlib') return { hit: true, value: nodeZlib };
  return { hit: false };
}

function cannotFindModuleError(id: string): Error {
  if (id.startsWith('.') || id.startsWith('/') || id.startsWith('node:')) {
    return new Error(`Cannot find module '${id}'`);
  }
  const name = id.startsWith('@') ? id.split('/').slice(0, 2).join('/') : id.split('/')[0];
  return new Error(`Cannot find module '${id}' (run: ipk install ${name})`);
}

/**
 * Resolve a `sliccy:<name>` specifier against the per-realm registry. Unknown
 * names and the empty form throw a scheme-specific error; sliccy: requires
 * NEVER consult the require cache or fall through to node-builtin handling.
 */
function resolveSliccyModule(id: string, sliccyModules: Record<string, unknown>): unknown {
  const name = id.slice(SLICCY_SCHEME.length);
  if (name === '') {
    throw new Error("require('sliccy:'): empty sliccy: module name");
  }
  if (!Object.prototype.hasOwnProperty.call(sliccyModules, name)) {
    throw new Error(
      `require('${id}'): unknown sliccy: module '${name}'. Known names: ${Object.keys(sliccyModules).sort().join(', ')}`
    );
  }
  return sliccyModules[name];
}

const UNAVAILABLE_BUILTIN_HINTS: Record<string, string> = {
  http: ' Use fetch() instead.',
  https: ' Use fetch() instead.',
  crypto: ' Use globalThis.crypto (Web Crypto API) instead.',
};

function unavailableBuiltinError(id: string, bareId: string): Error {
  return new Error(
    `require('${id}'): Node built-in '${bareId}' is not available in the browser environment.${UNAVAILABLE_BUILTIN_HINTS[bareId] || ''}`
  );
}

/**
 * Compile `code` into an `AsyncFunction` whose parameter names are the keys of
 * `bridges` (`fs`, `process`, `console`, …) and invoke it with their values.
 * Returns the process exit code: `NodeExitError.code` on `process.exit`, `1`
 * on any other throw (stack written to stderr), `0` otherwise.
 *
 * Node runs a CommonJS entry (a `node <script.js>` target, a `node -e`
 * snippet, an `ipx`/`npx` bin) in SLOPPY mode, but an ES-module entry in
 * STRICT mode. `isEsmEntry` carries that distinction: only an ESM-derived
 * entry (transpiled to `graph.entrySource`) gets the `"use strict"` prefix; a
 * plain-CJS entry runs without it so strict-only reserved words (e.g. a `var
 * implements`) parse as Node would. Required/dependency CJS modules are
 * evaluated sloppy elsewhere and are unaffected.
 */
export async function runUserCode(
  code: string,
  bridges: Record<string, unknown>,
  writeStderr: (value: unknown) => void,
  isEsmEntry: boolean
): Promise<number> {
  const names = Object.keys(bridges);
  const values = names.map((n) => bridges[n]);
  const AsyncFn = Object.getPrototypeOf(async function () {
    /* noop */
  }).constructor as new (
    ...args: string[]
  ) => (...args: unknown[]) => Promise<unknown>;
  const fn = new AsyncFn(...names, `${isEsmEntry ? '"use strict";\n' : ''}${code}`);
  try {
    await fn(...values);
    return 0;
  } catch (err: unknown) {
    if (err instanceof NodeExitError) return err.code;
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    writeStderr(`${message}\n`);
    return 1;
  }
}
