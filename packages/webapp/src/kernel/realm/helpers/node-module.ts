import { isNodeBuiltin, NODE_BUILTINS } from '../node-builtins.js';
import { nodePath } from './node-path.js';
import { nodeUrl } from './node-url.js';

export interface NodeRequireFunction {
  (id: string): unknown;
  resolve(id: string, options?: { paths?: readonly string[] }): string;
}

export type NodeModuleApi = ((id?: string) => NodeModuleInstance) & {
  createRequire: (filename: unknown) => NodeRequireFunction;
  builtinModules: readonly string[];
  isBuiltin: (name: unknown) => boolean;
  _nodeModulePaths: (from: string) => string[];
  Module: NodeModuleApi;
};

export interface NodeModuleInstance {
  exports: object;
  id: string;
  filename: string;
  loaded: boolean;
}

export interface NodeModuleHost {
  requireFrom(fromPath: string, specifier: string): unknown;
  resolveFrom(fromPath: string, specifier: string): string;
}

export const BUILTIN_MODULES: readonly string[] = Object.freeze([...NODE_BUILTINS]);

export function isBuiltinName(name: unknown): boolean {
  return typeof name === 'string' && isNodeBuiltin(name);
}

export function nodeModulePaths(from: string): string[] {
  const paths: string[] = [];
  let current = from;
  while (true) {
    const base = current === '/' ? '' : current.slice(current.lastIndexOf('/') + 1);
    if (base !== 'node_modules') {
      paths.push(current === '/' || current === '' ? '/node_modules' : `${current}/node_modules`);
    }
    if (current === '/' || current === '') break;
    const idx = current.lastIndexOf('/');
    current = idx <= 0 ? (idx === 0 ? '/' : '') : current.slice(0, idx);
  }
  return paths;
}

export function filenameToPath(filename: unknown): string {
  if (filename instanceof URL) return nodeUrl.fileURLToPath(filename);
  if (typeof filename === 'string') {
    if (filename.startsWith('file:')) return nodeUrl.fileURLToPath(filename);
    if (filename.startsWith('/')) return filename;
  }
  throw new TypeError(
    `The argument 'filename' must be a file URL object, file URL string, or absolute path string. Received ${String(filename)}`
  );
}

export function resolveFileCandidates(fromDir: string, specifier: string): string[] {
  const base = specifier.startsWith('/')
    ? nodePath.normalize(specifier)
    : nodePath.resolve(fromDir, specifier);
  if (/\.(?:js|json|cjs|mjs)$/.test(base)) return [base];
  return [
    base,
    `${base}.js`,
    `${base}.json`,
    `${base}.cjs`,
    `${base}/index.js`,
    `${base}/index.json`,
  ];
}

export function pickExistingCandidate(
  fromDir: string,
  specifier: string,
  exists: (path: string) => boolean
): string | undefined {
  for (const candidate of resolveFileCandidates(fromDir, specifier)) {
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

export function pickBarePackage(
  fromDir: string,
  specifier: string,
  exists: (path: string) => boolean
): string | undefined {
  for (const nm of nodeModulePaths(fromDir)) {
    const hit = pickExistingCandidate(nm, specifier, exists);
    if (hit) return hit;
  }
  return undefined;
}

export function isPathSpecifier(specifier: string): boolean {
  return specifier.startsWith('.') || specifier.startsWith('/');
}

export function createNodeModule(host: NodeModuleHost): NodeModuleApi {
  function ModuleCtor(id?: string): NodeModuleInstance {
    return { exports: {}, id: id ?? '', filename: id ?? '', loaded: false };
  }
  const api = ModuleCtor as NodeModuleApi;
  api.createRequire = (filename) => makeRequire(host, filename);
  api.builtinModules = BUILTIN_MODULES;
  api.isBuiltin = isBuiltinName;
  api._nodeModulePaths = nodeModulePaths;
  api.Module = api;
  return api;
}

function makeRequire(host: NodeModuleHost, filename: unknown): NodeRequireFunction {
  const parentPath = filenameToPath(filename);
  const req = ((id: string) => host.requireFrom(parentPath, id)) as NodeRequireFunction;
  req.resolve = (id, options) => {
    if (options?.paths && options.paths.length > 0) {
      let lastError: unknown;
      for (const dir of options.paths) {
        try {
          return host.resolveFrom(directoryAsFilename(dir), id);
        } catch (err) {
          lastError = err;
        }
      }
      throw lastError instanceof Error ? lastError : new Error(`Cannot find module '${id}'`);
    }
    return host.resolveFrom(parentPath, id);
  };
  return req;
}

function directoryAsFilename(dir: string): string {
  const trimmed = dir.endsWith('/') && dir !== '/' ? dir.slice(0, -1) : dir;
  return `${trimmed}/noop.js`;
}
