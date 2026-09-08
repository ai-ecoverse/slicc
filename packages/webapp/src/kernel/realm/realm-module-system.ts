/**
 * `realm-module-system.ts` — the realm's synchronous CJS module system over
 * a host-resolved module graph: `require()` shim, bare/`node:`/`sliccy:`
 * resolution, and the `AsyncFunction` user-code runner. Extracted from
 * `js-realm-shared.ts`; no behavior change.
 */

import type { NodeReadlineModule } from './helpers/node-readline.js';
import {
  createNodeModule,
  fmt,
  isPathSpecifier,
  type NodeChildProcess,
  type NodeModuleApi,
  type NodeOs,
  type NodeUtil,
  nodeAssert,
  nodeAssertStrict,
  nodeCrypto,
  nodeEvents,
  nodeOs,
  nodePath,
  nodeStream,
  nodeTty,
  nodeUrl,
  nodeUtil,
  nodeZlib,
  pickBarePackage,
  pickExistingCandidate,
  pool,
  time,
} from './js-realm-helpers.js';
import { isNodeBuiltin, NODE_BUILTINS_UNAVAILABLE } from './node-builtins.js';
import { createPlaywrightShim } from './playwright-shim.js';
import { dirnameOf, NodeExitError } from './realm-node-shims.js';
import type { RealmRpcClient } from './realm-rpc.js';
import type { RealmModuleGraph } from './realm-types.js';
import { NODE_NATIVE_PACKAGES, nativePackageError } from './require-guards.js';

const SLICCY_SCHEME = 'sliccy:';

/**
 * Realm-served modules keyed by bare specifier name (`sliccy:` bridges,
 * shimmed npm packages). Values are whatever each module exposes.
 */
export type RealmModuleRegistry = { [moduleName: string]: unknown };

/** A CJS `module.exports` bag — user-module-defined, arbitrary keys. */
export type ModuleExports = { [exportName: string]: unknown };

/** The named globals injected as the user-code AsyncFunction's parameters. */
export type RealmUserCodeBridges = { [globalName: string]: unknown };

/** `globalThis` narrowed to the realm's optional `Buffer` polyfill. */
type GlobalWithBuffer = typeof globalThis & { Buffer?: unknown };

export function buildSliccyModules(bridges: RealmModuleRegistry): RealmModuleRegistry {
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
 * Cheap pre-check: does the entry need the host graph / entry transpile?
 * `import` covers static and dynamic import; `export\b` (not `exports`)
 * covers an export-only ESM entry so `node --input-type=module -e 'export
 * const x = 1'` and `node file.mjs` with only `export` still get lowered
 * to CJS. CJS `exports.foo = 1` must not trip this.
 */
function mightNeedModuleGraph(code: string): boolean {
  return (
    code.includes('require') || code.includes('import') || /(?:^|[;\n}])\s*export\b/.test(code)
  );
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
  if (!mightNeedModuleGraph(code)) {
    return { files: [], entryMap: {}, edges: {}, edgeErrors: {}, errors: {} };
  }
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
  const obj = exp as ModuleExports;
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
export function buildShimmedPackages(rpc: RealmRpcClient): RealmModuleRegistry {
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
  sliccyModules: RealmModuleRegistry;
  shimmedPackages?: RealmModuleRegistry;
  /** Per-realm `readline` module (question() echoes to THIS realm's stdout). */
  nodeReadline?: NodeReadlineModule;
  /**
   * Per-realm `os` module — `tmpdir()`/`homedir()` answer for THIS realm's
   * unit (#2267). Omitted, the envless default keeps the pre-#2267 constants.
   */
  nodeOsModule?: NodeOs;
  /**
   * Per-realm `util` module — `util.deprecate`'s one-shot warning lands on
   * THIS realm's stderr. Omitted, the sink-less default drops the warning
   * rather than misrouting it to the kernel worker's console.
   */
  nodeUtilModule?: NodeUtil;
}): { require: (id: string) => unknown } {
  const {
    graph,
    fsBridge,
    processShim,
    childProcess,
    nodeConsole,
    sliccyModules,
    shimmedPackages = {},
    nodeReadline,
    nodeOsModule = nodeOs,
    nodeUtilModule = nodeUtil,
  } = opts;
  const sourceByPath = new Map(graph.files.map((f) => [f.path, f.cjsSource]));
  const kindByPath = new Map(graph.files.map((f) => [f.path, f.kind]));
  const cache = new Map<string, { exports: ModuleExports }>();

  const nodeModule: NodeModuleApi = createNodeModule({
    requireFrom: (fromPath, specifier) => loadFromParent(fromPath, specifier),
    resolveFrom: (fromPath, specifier) => resolveFromParent(fromPath, specifier),
  });

  const resolveBuiltin = (id: string): { hit: boolean; value?: unknown } => {
    if (typeof id === 'string' && id.startsWith(SLICCY_SCHEME)) {
      return { hit: true, value: resolveSliccyModule(id, sliccyModules) };
    }
    const bareId = id.startsWith('node:') ? id.slice(5) : id;
    const served = resolveServedBuiltin(bareId, {
      fsBridge,
      processShim,
      childProcess,
      nodeOsModule,
      nodeUtilModule,
      nodeReadline,
      nodeModule,
    });
    if (served.hit) return served;
    if (NODE_NATIVE_PACKAGES.has(bareId)) throw nativePackageError(id, bareId);
    if (NODE_BUILTINS_UNAVAILABLE.has(bareId)) throw unavailableBuiltinError(id, bareId);
    if (bareId in shimmedPackages) return { hit: true, value: shimmedPackages[bareId] };
    return { hit: false };
  };

  /**
   * Resolve one specifier for the module at `fromPath` (`null` for the entry).
   * Deferred failures are consulted only after the edge lookup misses, so a
   * specifier the host DID resolve is never shadowed by a stale error entry.
   */
  const requireFromEdges = (
    edgeMap: Record<string, string> | undefined,
    id: string,
    fromPath: string | null
  ): unknown => {
    const builtin = resolveBuiltin(id);
    if (builtin.hit) return builtin.value;
    const targetPath = edgeMap?.[id];
    if (targetPath) return requireFile(targetPath);
    // The host deferred this specifier's resolution failure to require time
    // (Node semantics), so surface its exact message now.
    const deferred = fromPath === null ? graph.errors[id] : graph.edgeErrors?.[fromPath]?.[id];
    if (deferred) throw new Error(deferred);
    throw cannotFindModuleError(id);
  };

  function requireFile(path: string): ModuleExports {
    const cached = cache.get(path);
    if (cached) return cached.exports;
    const source = sourceByPath.get(path);
    if (source === undefined) throw new Error(`Cannot find module '${path}'`);
    const moduleObj = { exports: {} as ModuleExports };
    // Register before evaluation so a require cycle sees the partial exports.
    cache.set(path, moduleObj);
    const childRequire = (id: string): unknown => requireFromEdges(graph.edges[path], id, path);
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
      (globalThis as GlobalWithBuffer).Buffer,
      globalThis
    );
    if (kindByPath.get(path) === 'cjs') synthesizeEsModuleDefault(moduleObj.exports);
    return moduleObj.exports;
  }

  function graphHas(path: string): boolean {
    return sourceByPath.has(path);
  }

  /**
   * Resolve `specifier` as if required from `fromPath`. Node builtins
   * (including unavailable ones) return the specifier without loading —
   * Node's `require.resolve('net')` does the same. Then the host-resolved
   * edge map, a runtime relative/absolute lookup, and a nearest-node_modules
   * walk over the already-loaded graph (so `createRequire(filename)` with a
   * synthetic filename can still resolve a bare package that a static
   * `require()` already pulled in).
   */
  function resolveFromParent(fromPath: string, specifier: string): string {
    if (isNodeBuiltin(specifier)) return specifier;
    const edged = graph.edges[fromPath]?.[specifier];
    if (edged) return edged;
    const fromDir = dirnameOf(fromPath);
    if (isPathSpecifier(specifier)) {
      const resolved = pickExistingCandidate(fromDir, specifier, graphHas);
      if (resolved) return resolved;
    } else {
      const resolved = pickBarePackage(fromDir, specifier, graphHas);
      if (resolved) return resolved;
    }
    const deferred = graph.edgeErrors?.[fromPath]?.[specifier];
    if (deferred) throw new Error(deferred);
    throw cannotFindModuleError(specifier);
  }

  function loadFromParent(fromPath: string, specifier: string): unknown {
    const builtin = resolveBuiltin(specifier);
    if (builtin.hit) return builtin.value;
    return requireFile(resolveFromParent(fromPath, specifier));
  }

  return {
    require: (id: string): unknown => requireFromEdges(graph.entryMap, id, null),
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
  served: {
    fsBridge: unknown;
    processShim: unknown;
    childProcess: NodeChildProcess;
    nodeOsModule: NodeOs;
    nodeUtilModule: NodeUtil;
    nodeReadline?: NodeReadlineModule;
    nodeModule?: NodeModuleApi;
  }
): { hit: boolean; value?: unknown } {
  const {
    fsBridge,
    processShim,
    childProcess,
    nodeOsModule,
    nodeUtilModule,
    nodeReadline,
    nodeModule,
  } = served;
  if (bareId === 'fs') return { hit: true, value: fsBridge };
  // Same object — fsBridge is already Promise-based; callback/sync APIs are not shimmed here.
  if (bareId === 'fs/promises') return { hit: true, value: fsBridge };
  if (bareId === 'path') return { hit: true, value: nodePath };
  if (bareId === 'crypto') return { hit: true, value: nodeCrypto };
  if (bareId === 'child_process') return { hit: true, value: childProcess };
  if (bareId === 'process') return { hit: true, value: processShim };
  if (bareId === 'buffer') {
    return { hit: true, value: { Buffer: (globalThis as GlobalWithBuffer).Buffer } };
  }
  if (bareId === 'assert') return { hit: true, value: nodeAssert };
  if (bareId === 'assert/strict') return { hit: true, value: nodeAssertStrict };
  if (bareId === 'util') return { hit: true, value: nodeUtilModule };
  if (bareId === 'events') return { hit: true, value: nodeEvents };
  if (bareId === 'os') return { hit: true, value: nodeOsModule };
  if (bareId === 'tty') return { hit: true, value: nodeTty };
  if (bareId === 'stream') return { hit: true, value: nodeStream };
  if (bareId === 'url') return { hit: true, value: nodeUrl };
  if (bareId === 'zlib') return { hit: true, value: nodeZlib };
  // Per-realm (question() echoes to the realm's stdout), so a realm booted
  // without one (none today) falls through to the unavailable-builtin error.
  if (bareId === 'readline' && nodeReadline) return { hit: true, value: nodeReadline };
  if (bareId === 'readline/promises' && nodeReadline) {
    return { hit: true, value: nodeReadline.promises };
  }
  if (bareId === 'module' && nodeModule) return { hit: true, value: nodeModule };
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
function resolveSliccyModule(id: string, sliccyModules: RealmModuleRegistry): unknown {
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
  bridges: RealmUserCodeBridges,
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
