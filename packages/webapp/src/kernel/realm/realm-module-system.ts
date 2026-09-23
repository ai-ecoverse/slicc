import type { NodeReadlineModule } from './helpers/node-readline.js';
import {
  createNodeModule,
  createNodePath,
  fmt,
  isPathSpecifier,
  type NodeChildProcess,
  type NodeModuleApi,
  type NodeOs,
  type NodePath,
  type NodeUtil,
  nodeAssert,
  nodeAssertStrict,
  nodeCrypto,
  nodeEvents,
  nodeOs,
  nodeStream,
  nodeTty,
  nodeUrl,
  nodeUtil,
  nodeVm,
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

export type RealmModuleRegistry = { [moduleName: string]: unknown };

export type ModuleExports = { [exportName: string]: unknown };

export type RealmUserCodeBridges = { [globalName: string]: unknown };

type GlobalWithBuffer = typeof globalThis & { Buffer?: unknown };

export function buildSliccyModules(bridges: RealmModuleRegistry): RealmModuleRegistry {
  return { ...bridges, time, fmt, pool };
}

function entryFromDir(filename: string, cwd: string): string {
  return filename?.startsWith('/') ? dirnameOf(filename) : cwd;
}

function mightNeedModuleGraph(code: string): boolean {
  return (
    code.includes('require') || code.includes('import') || /(?:^|[;\n}])\s*export\b/.test(code)
  );
}

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

function synthesizeEsModuleDefault(exp: unknown): void {
  if (exp === null || typeof exp !== 'object') return;
  const obj = exp as ModuleExports;
  if (!obj.__esModule) return;
  if (Object.prototype.hasOwnProperty.call(obj, 'default')) return;
  if (!Object.isExtensible(obj)) return;
  try {
    Object.defineProperty(obj, 'default', { value: obj, enumerable: false, configurable: true });
  } catch {}
}

export function buildShimmedPackages(rpc: RealmRpcClient): RealmModuleRegistry {
  return {
    playwright: createPlaywrightShim(rpc),
  };
}

export function createModuleSystem(opts: {
  graph: RealmModuleGraph;
  fsBridge: unknown;
  processShim: unknown;
  childProcess: NodeChildProcess;
  nodeConsole: unknown;
  sliccyModules: RealmModuleRegistry;
  shimmedPackages?: RealmModuleRegistry;

  nodeReadline?: NodeReadlineModule;

  nodeOsModule?: NodeOs;

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

  const nodePathModule = createNodePath(() => {
    const cwd = (processShim as { cwd?: () => string } | null)?.cwd?.();
    return typeof cwd === 'string' && cwd.length > 0 ? cwd : '/';
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
      nodePathModule,
      nodeReadline,
      nodeModule,
    });
    if (served.hit) return served;
    if (NODE_NATIVE_PACKAGES.has(bareId)) throw nativePackageError(id, bareId);
    if (NODE_BUILTINS_UNAVAILABLE.has(bareId)) throw unavailableBuiltinError(id, bareId);
    if (bareId in shimmedPackages) return { hit: true, value: shimmedPackages[bareId] };
    return { hit: false };
  };

  const requireFromEdges = (
    edgeMap: Record<string, string> | undefined,
    id: string,
    fromPath: string | null
  ): unknown => {
    const builtin = resolveBuiltin(id);
    if (builtin.hit) return builtin.value;
    const targetPath = edgeMap?.[id];
    if (targetPath) return requireFile(targetPath);

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

    cache.set(path, moduleObj);
    const childRequire = (id: string): unknown => requireFromEdges(graph.edges[path], id, path);
    const names = ['module', 'exports', 'require', 'process', 'console', 'Buffer', 'global'];
    const values: unknown[] = [
      moduleObj,
      moduleObj.exports,
      childRequire,
      processShim,
      nodeConsole,
      (globalThis as GlobalWithBuffer).Buffer,
      globalThis,
    ];

    if (kindByPath.get(path) !== 'esm') {
      names.push('__dirname', '__filename');
      values.push(dirnameOf(path), path);
    }
    const compiled = new Function(...names, source) as (...args: unknown[]) => void;
    compiled(...values);
    if (kindByPath.get(path) === 'cjs') synthesizeEsModuleDefault(moduleObj.exports);
    return moduleObj.exports;
  }

  function graphHas(path: string): boolean {
    return sourceByPath.has(path);
  }

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

function resolveServedBuiltin(
  bareId: string,
  served: {
    fsBridge: unknown;
    processShim: unknown;
    childProcess: NodeChildProcess;
    nodeOsModule: NodeOs;
    nodeUtilModule: NodeUtil;
    nodePathModule: NodePath;
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
    nodePathModule,
    nodeReadline,
    nodeModule,
  } = served;
  if (bareId === 'fs') return { hit: true, value: fsBridge };

  if (bareId === 'fs/promises') return { hit: true, value: fsBridge };
  if (bareId === 'path') return { hit: true, value: nodePathModule };
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
  if (bareId === 'vm') return { hit: true, value: nodeVm };

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

export async function runUserCode(
  code: string,
  bridges: RealmUserCodeBridges,
  writeStderr: (value: unknown) => void,
  isEsmEntry: boolean
): Promise<number> {
  const names = Object.keys(bridges);
  const values = names.map((n) => bridges[n]);
  const AsyncFn = Object.getPrototypeOf(async function () {}).constructor as new (
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
