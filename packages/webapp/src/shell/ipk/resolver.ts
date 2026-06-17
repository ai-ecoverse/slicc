/**
 * Install-time dependency-tree resolution for ipk (Ice Pack).
 *
 * Pure, dependency-light, individually unit-testable. Given a set of root
 * dependencies (name -> range) and a packument supplier, walk the transitive
 * graph and produce an `InstallPlan` describing the npm-style node_modules
 * layout: compatible duplicates are hoisted to the top, conflicting versions
 * are nested under the dependent's `node_modules/<dep>/node_modules/...`.
 *
 * Placement follows npm/Arborist nearest-scope, satisfies-based dedup:
 *   1. For each edge (name, range) under parent P, walk P's node_modules
 *      ancestor chain NEAREST-FIRST and then the top level to find the
 *      nearest already-placed node for `name`.
 *   2. If the nearest placed `name`'s resolved version satisfies `range`,
 *      REUSE it (no re-resolution, no nested copy).
 *   3. Otherwise resolve `range` to a concrete version and either NEST a
 *      fresh node under P (incompatible) or HOIST one to the top level
 *      (no `name` reachable in any scope).
 *
 * Cycle termination is robust for ALL cycles, including conflicting-version
 * cycles whose concrete versions drift around the loop: when resolving the
 * incoming range yields a name@version that already appears in-progress on
 * the current ancestor path, we place a FRESH terminal node (with empty
 * dependencies) under the requester rather than recursing again or linking
 * back to the in-progress ancestor. The fresh terminal node keeps require()
 * reachability correct while keeping the InstallPlan a finite tree with no
 * object-graph cycles (so it stays serializable and safe to walk).
 *
 * This module owns BOTH architecture 4.1 resolution responsibilities:
 *   #1 install-time dependency-tree resolution (`resolveDependencyTree`); and
 *   #2 require/ipx-time Node module resolution (`resolve`), implementing the
 *      architecture §5 algorithm (scheme check -> relative/absolute path with
 *      extension/json/index resolution -> nearest-node_modules walk ->
 *      package.json exports/main/index entry selection, incl. scoped packages
 *      and deep subpaths). Building the ordered CJS module GRAPH from those
 *      resolutions is a separate concern handled by `module-loader.ts`.
 */

import { joinPath, splitPath } from '../../fs/path-utils.js';
import { NODE_BUILTINS } from '../../kernel/realm/node-builtins.js';
import type { Packument, PackumentVersion } from './registry.js';
import { resolveVersion } from './registry.js';
import { satisfies } from './semver.js';

export interface InstallNode {
  name: string;
  version: string;
  resolved: string;
  integrity?: string;
  dependencies: Record<string, InstallNode>;
}

export interface InstallPlan {
  root: Record<string, InstallNode>;
}

export type PackumentSupplier = (name: string) => Promise<Packument> | Packument;

export interface ResolveDependencyTreeOptions {
  rootDependencies: Record<string, string>;
  fetchPackument: PackumentSupplier;
}

/**
 * Resolve the full transitive install plan for `rootDependencies`.
 *
 * The plan is shaped like an npm-style `node_modules` tree:
 *   - the nearest reachable already-placed version that SATISFIES the
 *     incoming range is reused (no re-resolution, no nested copy);
 *   - if the nearest reachable version does not satisfy, a fresh node is
 *     nested under the dependent's `node_modules`;
 *   - if no copy is reachable, a fresh node is hoisted to the top level.
 *
 * Packuments are fetched on demand via the supplied `fetchPackument` and
 * memoized so each name is queried at most once.
 */
export async function resolveDependencyTree(
  options: ResolveDependencyTreeOptions
): Promise<InstallPlan> {
  const top: Record<string, InstallNode> = {};
  const packumentCache = new Map<string, Packument>();

  async function getPackument(name: string): Promise<Packument> {
    let cached = packumentCache.get(name);
    if (cached) return cached;
    cached = await options.fetchPackument(name);
    packumentCache.set(name, cached);
    return cached;
  }

  async function place(name: string, range: string, ancestors: InstallNode[]): Promise<void> {
    const nearest = findNearest(name, ancestors, top);
    if (nearest && satisfies(nearest.version, range)) {
      return;
    }

    const resolved = await resolveEdge(name, range, getPackument);
    if (isInProgress(name, resolved.version, ancestors)) {
      const requester = ancestors[0];
      if (requester) {
        // Shadowed cycle: the in-progress satisfying version is not the nearest
        // reachable copy from the requester's scope, so place a fresh terminal
        // node under the requester to keep require() reachability correct
        // without introducing an object-graph cycle into the InstallPlan.
        requester.dependencies[name] = buildNode(name, resolved.version, resolved.entry);
      }
      return;
    }

    const node = buildNode(name, resolved.version, resolved.entry);
    attachNode(top, node, nearest, ancestors);

    const childAncestors: InstallNode[] = [node, ...ancestors];
    const deps = resolved.entry.dependencies ?? {};
    for (const [depName, depRange] of Object.entries(deps)) {
      await place(depName, depRange, childAncestors);
    }
  }

  for (const [name, range] of Object.entries(options.rootDependencies)) {
    await place(name, range, []);
  }

  return { root: top };
}

function findNearest(
  name: string,
  ancestors: InstallNode[],
  top: Record<string, InstallNode>
): InstallNode | null {
  for (const a of ancestors) {
    const inAncestor = a.dependencies[name];
    if (inAncestor) return inAncestor;
  }
  return top[name] ?? null;
}

interface ResolvedEdge {
  version: string;
  entry: PackumentVersion;
}

async function resolveEdge(
  name: string,
  range: string,
  getPackument: (name: string) => Promise<Packument>
): Promise<ResolvedEdge> {
  let packument: Packument;
  let version: string;
  try {
    packument = await getPackument(name);
    version = resolveVersion(packument, range);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`resolveDependencyTree: failed to resolve ${name}@${range}: ${reason}`);
  }

  const entry = packument.versions[version] as PackumentVersion | undefined;
  if (!entry?.dist?.tarball) {
    throw new Error(
      `resolveDependencyTree: ${name}@${version} has no dist.tarball in the packument`
    );
  }
  return { version, entry };
}

function isInProgress(name: string, version: string, ancestors: InstallNode[]): boolean {
  for (const a of ancestors) {
    if (a.name === name && a.version === version) return true;
  }
  return false;
}

function buildNode(name: string, version: string, entry: PackumentVersion): InstallNode {
  const node: InstallNode = {
    name,
    version,
    resolved: entry.dist.tarball,
    dependencies: {},
  };
  if (typeof entry.dist.integrity === 'string') {
    node.integrity = entry.dist.integrity;
  }
  return node;
}

function attachNode(
  top: Record<string, InstallNode>,
  node: InstallNode,
  nearest: InstallNode | null,
  ancestors: InstallNode[]
): void {
  const parent = nearest ? ancestors[0] : null;
  if (parent) {
    parent.dependencies[node.name] = node;
  } else {
    top[node.name] = node;
  }
}

// ---------------------------------------------------------------------------
// Require/ipx-time Node module resolution (architecture 4.1 #2, §5)
// ---------------------------------------------------------------------------

/** Detected source kind of a resolved module file. */
export type ModuleKind = 'cjs' | 'esm' | 'json';

/** A bare specifier resolved to a `node:`/bare Node built-in. */
export interface ResolvedBuiltin {
  type: 'builtin';
  /** The original specifier, e.g. `node:path` or `fs`. */
  specifier: string;
  /** The bare built-in name with any `node:` prefix stripped, e.g. `path`. */
  name: string;
}

/** A `sliccy:<name>` capability specifier. */
export interface ResolvedSliccy {
  type: 'sliccy';
  /** The original specifier, e.g. `sliccy:exec`. */
  specifier: string;
  /** The capability name after the scheme, e.g. `exec`. */
  name: string;
}

/** A specifier resolved to a concrete VFS file. */
export interface ResolvedFile {
  type: 'file';
  /** Absolute, normalized VFS path of the resolved module file. */
  path: string;
  /** Detected module kind for the resolved file. */
  moduleKind: ModuleKind;
}

export type ResolveResult = ResolvedBuiltin | ResolvedSliccy | ResolvedFile;

/**
 * Minimal read-only VFS surface the resolver needs. Both the real `VirtualFS`
 * (via {@link createVfsModuleReader}) and synthesized in-memory trees in unit
 * tests can satisfy it, so resolution stays pure and host-side.
 */
export interface ModuleReader {
  exists(path: string): Promise<boolean>;
  isDirectory(path: string): Promise<boolean>;
  readFile(path: string): Promise<string>;
}

export interface ResolveOptions {
  /**
   * Ordered `exports`/condition priority list. Defaults to the CJS-require
   * order; pass `['node', 'import', 'default']` for `import`-time resolution.
   */
  conditions?: string[];
}

const SLICCY_SCHEME = 'sliccy:';
const NODE_SCHEME = 'node:';

/** Candidate extensions, tried in order, for extensionless/file resolution. */
const RESOLVE_EXTENSIONS = ['.js', '.cjs', '.mjs', '.json'] as const;

/** Index basenames, tried in order, for directory resolution. */
const INDEX_CANDIDATES = ['index.js', 'index.cjs', 'index.mjs', 'index.json'] as const;

const DEFAULT_CONDITIONS = ['node', 'require', 'default'];

interface ResolverManifest {
  type?: unknown;
  main?: unknown;
  module?: unknown;
  exports?: unknown;
}

function dirOf(path: string): string {
  return splitPath(path).dir;
}

function isPathSpecifier(specifier: string): boolean {
  return (
    specifier === '.' ||
    specifier === '..' ||
    specifier.startsWith('./') ||
    specifier.startsWith('../') ||
    specifier.startsWith('/')
  );
}

interface ParsedBareSpecifier {
  name: string;
  subpath: string;
}

function parseBareSpecifier(specifier: string): ParsedBareSpecifier {
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    return { name: parts.slice(0, 2).join('/'), subpath: parts.slice(2).join('/') };
  }
  const slash = specifier.indexOf('/');
  if (slash === -1) return { name: specifier, subpath: '' };
  return { name: specifier.slice(0, slash), subpath: specifier.slice(slash + 1) };
}

async function isFile(reader: ModuleReader, path: string): Promise<boolean> {
  if (!(await reader.exists(path))) return false;
  return !(await reader.isDirectory(path));
}

async function loadAsFile(reader: ModuleReader, path: string): Promise<string | null> {
  if (await isFile(reader, path)) return path;
  for (const ext of RESOLVE_EXTENSIONS) {
    const candidate = path + ext;
    if (await isFile(reader, candidate)) return candidate;
  }
  return null;
}

async function loadAsIndex(reader: ModuleReader, dir: string): Promise<string | null> {
  for (const name of INDEX_CANDIDATES) {
    const candidate = joinPath(dir, name);
    if (await isFile(reader, candidate)) return candidate;
  }
  return null;
}

/**
 * Resolve a path as a file (with extension probing), preferring a matching
 * FILE over a same-named directory, then as a directory (package.json entry
 * selection, then index.*). Returns the resolved file path or null.
 */
async function loadAsFileOrDirectory(
  reader: ModuleReader,
  path: string,
  conditions: string[],
  visited?: Set<string>
): Promise<string | null> {
  const asFile = await loadAsFile(reader, path);
  if (asFile) return asFile;
  if (await reader.isDirectory(path)) {
    return loadAsDirectory(reader, path, conditions, visited);
  }
  return null;
}

async function readManifest(reader: ModuleReader, dir: string): Promise<ResolverManifest | null> {
  const manifestPath = joinPath(dir, 'package.json');
  if (!(await isFile(reader, manifestPath))) return null;
  let text: string;
  try {
    text = await reader.readFile(manifestPath);
  } catch {
    return null;
  }
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as ResolverManifest;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid package.json at '${manifestPath}': ${reason}`);
  }
}

/**
 * Resolve an `exports` target (string, conditions object, or array of either)
 * against the ordered `conditions`. Returns the first matching relative target
 * string or null. `default` participates only when listed in `conditions`.
 */
function resolveExportsTarget(field: unknown, conditions: string[]): string | null {
  if (typeof field === 'string') return field;
  if (field === null || typeof field !== 'object') return null;
  if (Array.isArray(field)) {
    for (const item of field) {
      const resolved = resolveExportsTarget(item, conditions);
      if (resolved) return resolved;
    }
    return null;
  }
  const obj = field as Record<string, unknown>;
  for (const condition of conditions) {
    if (Object.hasOwn(obj, condition)) {
      const resolved = resolveExportsTarget(obj[condition], conditions);
      if (resolved) return resolved;
    }
  }
  return null;
}

/** True when `exports` is a subpath map (keys `.` / `./...`) vs a root target. */
function isSubpathExports(field: unknown): boolean {
  if (!field || typeof field !== 'object' || Array.isArray(field)) return false;
  return Object.keys(field as object).some((key) => key === '.' || key.startsWith('./'));
}

function rootExportsField(field: unknown): unknown {
  if (isSubpathExports(field)) {
    return (field as Record<string, unknown>)['.'];
  }
  return field;
}

/**
 * Resolve a manifest `main`/`module`/`exports` target relative to `dir`. An
 * entry that normalizes back to `dir` itself (e.g. `"."`/`"./"`) routes to
 * index.* resolution rather than re-entering directory resolution on the same
 * path (which would never terminate); a self-referencing entry with no index
 * returns null so the caller surfaces the clear `Cannot find module '<spec>'`
 * error. A non-self entry that cannot be resolved throws a `<label>` error.
 */
async function resolveManifestEntry(
  reader: ModuleReader,
  dir: string,
  target: string,
  conditions: string[],
  visited: Set<string>,
  label: string
): Promise<string | null> {
  const targetPath = joinPath(dir, target);
  const isSelf = targetPath === dir;
  const resolved = isSelf
    ? await loadAsIndex(reader, dir)
    : await loadAsFileOrDirectory(reader, targetPath, conditions, visited);
  if (resolved) return resolved;
  if (isSelf) return null;
  throw new Error(`Cannot find module: ${label} '${target}' missing in '${dir}'`);
}

async function loadAsDirectory(
  reader: ModuleReader,
  dir: string,
  conditions: string[],
  visited: Set<string> = new Set()
): Promise<string | null> {
  // A `main`/`module`/`exports` entry can normalize back to a directory already
  // being resolved (e.g. via a longer cross-directory cycle). Re-entering
  // directory resolution on such a path recurses forever, so resolve the
  // package index here instead — guaranteeing termination for any cycle.
  if (visited.has(dir)) return loadAsIndex(reader, dir);
  visited.add(dir);

  const manifest = await readManifest(reader, dir);
  if (manifest) {
    if (manifest.exports !== undefined) {
      const target = resolveExportsTarget(rootExportsField(manifest.exports), conditions);
      if (target) {
        return resolveManifestEntry(reader, dir, target, conditions, visited, 'exports entry');
      }
    }
    const entry =
      (typeof manifest.main === 'string' && manifest.main) ||
      (typeof manifest.module === 'string' && manifest.module) ||
      '';
    if (entry) {
      return resolveManifestEntry(reader, dir, entry, conditions, visited, 'main entry');
    }
  }
  return loadAsIndex(reader, dir);
}

async function resolveInPackage(
  reader: ModuleReader,
  pkgDir: string,
  subpath: string,
  conditions: string[]
): Promise<string | null> {
  if (subpath === '') {
    return loadAsDirectory(reader, pkgDir, conditions);
  }
  const manifest = await readManifest(reader, pkgDir);
  if (manifest?.exports !== undefined && isSubpathExports(manifest.exports)) {
    const sub = (manifest.exports as Record<string, unknown>)[`./${subpath}`];
    if (sub !== undefined) {
      const target = resolveExportsTarget(sub, conditions);
      if (target) {
        const resolved = await loadAsFileOrDirectory(reader, joinPath(pkgDir, target), conditions);
        if (resolved) return resolved;
        throw new Error(`Cannot find module: exports entry './${subpath}' missing in '${pkgDir}'`);
      }
    }
    // Subpath not declared in `exports`: fall through to direct path resolution
    // (subpath-exports encapsulation is intentionally not enforced in M4).
  }
  return loadAsFileOrDirectory(reader, joinPath(pkgDir, subpath), conditions);
}

async function findPackageDir(
  reader: ModuleReader,
  fromDir: string,
  name: string
): Promise<string | null> {
  let dir = fromDir || '/';
  while (true) {
    const candidate = joinPath(dir, 'node_modules', name);
    if (await reader.isDirectory(candidate)) return candidate;
    if (dir === '/' || dir === '') break;
    dir = dirOf(dir);
  }
  return null;
}

const ESM_IMPORT_RE = /(?:^|[;\n}])\s*import\b(?!\s*[(.])/;
const ESM_EXPORT_RE = /(?:^|[;\n}])\s*export\b/;
const IMPORT_META_RE = /\bimport\s*\.\s*meta\b/;

/**
 * Heuristically detect ESM syntax in a JS source. True when the source uses a
 * static `import`/`export` declaration or references `import.meta`. Dynamic
 * `import(...)` is NOT a marker (it is legal in CJS), and identifiers that
 * merely begin with `import`/`export` (e.g. `exports`, `important`) are not
 * matched. This decides syntax-based module-kind detection (architecture 4.4)
 * and guards the transpiler so plain CJS is never needlessly transpiled.
 */
export function hasEsmSyntax(source: string): boolean {
  return ESM_IMPORT_RE.test(source) || ESM_EXPORT_RE.test(source) || IMPORT_META_RE.test(source);
}

/**
 * Detect the module kind of a resolved file (architecture 4.4). Extension wins
 * first (`.json`/`.mjs`/`.cjs`). For a bare `.js`/extensionless entry the
 * nearest `package.json` `type` decides when present (`module` -> esm, any
 * other explicit type -> cjs); when no `type` field is declared (or no
 * `package.json` is found at all) the file's own syntax decides
 * (`import`/`export`/`import.meta` -> esm, otherwise cjs).
 */
export async function detectModuleKind(
  reader: ModuleReader,
  filePath: string
): Promise<ModuleKind> {
  if (filePath.endsWith('.json')) return 'json';
  if (filePath.endsWith('.mjs')) return 'esm';
  if (filePath.endsWith('.cjs')) return 'cjs';
  let dir = dirOf(filePath);
  while (true) {
    let manifest: ResolverManifest | null = null;
    try {
      manifest = await readManifest(reader, dir);
    } catch {
      manifest = null;
    }
    if (manifest) {
      if (manifest.type === 'module') return 'esm';
      // An explicit non-module `type` (e.g. `commonjs`) is authoritative;
      // only an absent `type` falls through to syntax detection.
      if (manifest.type !== undefined && manifest.type !== null) return 'cjs';
      break;
    }
    if (dir === '/' || dir === '') break;
    dir = dirOf(dir);
  }
  let source: string;
  try {
    source = await reader.readFile(filePath);
  } catch {
    return 'cjs';
  }
  return hasEsmSyntax(source) ? 'esm' : 'cjs';
}

/**
 * Resolve `specifier` from `fromDir` against `reader`, implementing the Node
 * resolution algorithm in architecture §5:
 *   - `node:` scheme + bare Node built-ins -> {@link ResolvedBuiltin};
 *   - `sliccy:` scheme -> {@link ResolvedSliccy} (empty name throws);
 *   - relative/absolute paths -> exact, then `.js`/`.cjs`/`.mjs`/`.json`,
 *     then `/index.*`, with file-over-directory precedence;
 *   - bare packages -> nearest-`node_modules` walk + package.json
 *     `exports`(conditions)/`main`/`module`/`index.js` selection, including
 *     scoped packages and deep subpaths.
 *
 * An uninstalled bare package throws exactly
 * `Cannot find module '<specifier>' (run: ipk install <name>)`. A relative or
 * already-installed-but-broken target throws `Cannot find module '<specifier>'`
 * without the install hint.
 */
export async function resolve(
  specifier: string,
  fromDir: string,
  reader: ModuleReader,
  options: ResolveOptions = {}
): Promise<ResolveResult> {
  const conditions = options.conditions ?? DEFAULT_CONDITIONS;

  if (specifier.startsWith(SLICCY_SCHEME)) {
    const name = specifier.slice(SLICCY_SCHEME.length);
    if (name === '') {
      throw new Error("Cannot resolve 'sliccy:': empty sliccy: module name");
    }
    return { type: 'sliccy', specifier, name };
  }

  if (specifier.startsWith(NODE_SCHEME)) {
    return { type: 'builtin', specifier, name: specifier.slice(NODE_SCHEME.length) };
  }

  // Every bare Node built-in (available OR browser-unavailable) is
  // graph-external: it must never be routed through node_modules resolution.
  // The realm require shim serves/guards it at require time.
  if (NODE_BUILTINS.has(specifier)) {
    return { type: 'builtin', specifier, name: specifier };
  }

  if (isPathSpecifier(specifier)) {
    const base = specifier.startsWith('/') ? specifier : joinPath(fromDir, specifier);
    const resolved = await loadAsFileOrDirectory(reader, base, conditions);
    if (!resolved) throw new Error(`Cannot find module '${specifier}'`);
    return { type: 'file', path: resolved, moduleKind: await detectModuleKind(reader, resolved) };
  }

  const { name, subpath } = parseBareSpecifier(specifier);
  const pkgDir = await findPackageDir(reader, fromDir, name);
  if (!pkgDir) {
    throw new Error(`Cannot find module '${specifier}' (run: ipk install ${name})`);
  }
  const resolved = await resolveInPackage(reader, pkgDir, subpath, conditions);
  if (!resolved) throw new Error(`Cannot find module '${specifier}'`);
  return { type: 'file', path: resolved, moduleKind: await detectModuleKind(reader, resolved) };
}

/** Structural slice of `VirtualFS` sufficient to back a {@link ModuleReader}. */
export interface VfsModuleReaderSource {
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<{ type: string }>;
  readFile(path: string, options?: unknown): Promise<string | Uint8Array>;
}

/** Adapt a `VirtualFS` (or compatible) into the {@link ModuleReader} surface. */
export function createVfsModuleReader(fs: VfsModuleReaderSource): ModuleReader {
  return {
    exists: (path) => fs.exists(path),
    isDirectory: async (path) => {
      try {
        return (await fs.stat(path)).type === 'directory';
      } catch {
        return false;
      }
    },
    readFile: async (path) => {
      const content = await fs.readFile(path);
      return typeof content === 'string' ? content : new TextDecoder().decode(content);
    },
  };
}
