import { joinPath, splitPath } from '../../fs/path-utils.js';
import { NODE_BUILTINS } from '../../kernel/realm/node-builtins.js';
import { GLOBAL_NODE_MODULES } from './global-prefix.js';
import type { Packument, PackumentVersion } from './registry.js';
import { resolveVersion } from './registry.js';
import { satisfies } from './semver.js';

export interface InstallNode {
  name: string;
  version: string;
  resolved: string;
  integrity?: string;

  bin?: string | Record<string, string>;
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
  if (entry.bin !== undefined && entry.bin !== null) {
    node.bin = entry.bin;
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

export type ModuleKind = 'cjs' | 'esm' | 'json';

export interface ResolvedBuiltin {
  type: 'builtin';

  specifier: string;

  name: string;
}

export interface ResolvedSliccy {
  type: 'sliccy';

  specifier: string;

  name: string;
}

export interface ResolvedFile {
  type: 'file';

  path: string;

  moduleKind: ModuleKind;
}

export type ResolveResult = ResolvedBuiltin | ResolvedSliccy | ResolvedFile;

export interface ModuleReader {
  exists(path: string): Promise<boolean>;
  isDirectory(path: string): Promise<boolean>;
  readFile(path: string): Promise<string>;
}

export interface ResolveOptions {
  conditions?: string[];
}

const SLICCY_SCHEME = 'sliccy:';
const NODE_SCHEME = 'node:';

const RESOLVE_EXTENSIONS = ['.js', '.cjs', '.mjs', '.json'] as const;

const INDEX_CANDIDATES = ['index.js', 'index.cjs', 'index.mjs', 'index.json'] as const;

const DEFAULT_CONDITIONS = ['node', 'require', 'default'];

interface ResolverManifest {
  type?: unknown;
  main?: unknown;
  module?: unknown;
  exports?: unknown;
  imports?: unknown;
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

// biome-ignore lint/plugin: package.json exports/imports maps are author-defined and open-ended per the Node spec; this alias is the single place that shape is named.
type PackageEntryMap = Record<string, unknown>;

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
  const obj = field as PackageEntryMap;
  for (const condition of conditions) {
    if (Object.hasOwn(obj, condition)) {
      const resolved = resolveExportsTarget(obj[condition], conditions);
      if (resolved) return resolved;
    }
  }
  return null;
}

function isSubpathExports(field: unknown): boolean {
  if (!field || typeof field !== 'object' || Array.isArray(field)) return false;
  return Object.keys(field as object).some((key) => key === '.' || key.startsWith('./'));
}

function rootExportsField(field: unknown): unknown {
  if (isSubpathExports(field)) {
    return (field as PackageEntryMap)['.'];
  }
  return field;
}

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
    const sub = (manifest.exports as PackageEntryMap)[`./${subpath}`];
    if (sub !== undefined) {
      const target = resolveExportsTarget(sub, conditions);
      if (target) {
        const resolved = await loadAsFileOrDirectory(reader, joinPath(pkgDir, target), conditions);
        if (resolved) return resolved;
        throw new Error(`Cannot find module: exports entry './${subpath}' missing in '${pkgDir}'`);
      }
    }
  }
  return loadAsFileOrDirectory(reader, joinPath(pkgDir, subpath), conditions);
}

export function nodeModulesSearchPath(fromDir: string): string[] {
  const dirs: string[] = [];
  let dir = fromDir || '/';
  while (true) {
    dirs.push(joinPath(dir, 'node_modules'));
    if (dir === '/' || dir === '') break;
    dir = dirOf(dir);
  }
  if (!dirs.includes(GLOBAL_NODE_MODULES)) {
    dirs.push(GLOBAL_NODE_MODULES);
  }
  return dirs;
}

async function findPackageDir(
  reader: ModuleReader,
  fromDir: string,
  name: string
): Promise<string | null> {
  for (const nodeModules of nodeModulesSearchPath(fromDir)) {
    const candidate = joinPath(nodeModules, name);
    if (await reader.isDirectory(candidate)) return candidate;
  }
  return null;
}

async function findPackageScope(reader: ModuleReader, fromDir: string): Promise<string | null> {
  let dir = fromDir || '/';
  while (true) {
    if (await isFile(reader, joinPath(dir, 'package.json'))) return dir;
    if (dir === '/' || dir === '') break;
    dir = dirOf(dir);
  }
  return null;
}

function browserPreferringConditions(conditions: string[]): string[] {
  const kind = conditions.includes('import') ? 'import' : 'require';
  return ['browser', kind, 'default'];
}

interface MatchedImport {
  field: unknown;

  star: string;
}

function matchImportsKey(specifier: string, importsMap: PackageEntryMap): MatchedImport | null {
  if (Object.hasOwn(importsMap, specifier)) {
    return { field: importsMap[specifier], star: '' };
  }
  for (const key of Object.keys(importsMap)) {
    const starIdx = key.indexOf('*');
    if (starIdx === -1) continue;
    if (key.indexOf('*', starIdx + 1) !== -1) continue;
    const prefix = key.slice(0, starIdx);
    const suffix = key.slice(starIdx + 1);
    if (specifier.length < prefix.length + suffix.length) continue;
    if (!specifier.startsWith(prefix)) continue;
    if (suffix && !specifier.endsWith(suffix)) continue;
    const star = specifier.slice(prefix.length, specifier.length - suffix.length);
    return { field: importsMap[key], star };
  }
  return null;
}

async function resolvePackageImports(
  specifier: string,
  fromDir: string,
  reader: ModuleReader,
  conditions: string[]
): Promise<string | null> {
  const scopeDir = await findPackageScope(reader, fromDir);
  if (!scopeDir) return null;
  const manifest = await readManifest(reader, scopeDir);
  const imports = manifest?.imports;
  if (!imports || typeof imports !== 'object' || Array.isArray(imports)) return null;
  const matched = matchImportsKey(specifier, imports as PackageEntryMap);
  if (!matched) return null;
  const browserConditions = browserPreferringConditions(conditions);
  const target = resolveExportsTarget(matched.field, browserConditions);
  if (!target) return null;
  const resolvedTarget = matched.star ? target.replace(/\*/g, matched.star) : target;
  return loadAsFileOrDirectory(reader, joinPath(scopeDir, resolvedTarget), browserConditions);
}

const ESM_IMPORT_RE = /(?:^|[;\n}])\s*import\b(?!\s*[(.])/;
const ESM_EXPORT_RE = /(?:^|[;\n}])\s*export\b/;
const IMPORT_META_RE = /\bimport\s*\.\s*meta\b/;

interface MaskFrame {
  template: boolean;
  brace: number;
}

function blankAt(out: string[], i: number): void {
  const c = out[i];
  if (c !== '\n' && c !== '\r') out[i] = ' ';
}

function maskQuoted(source: string, out: string[], start: number): number {
  const n = source.length;
  const quote = source[start];
  let i = start + 1;
  while (i < n) {
    const c = source[i];
    if (c === '\\') {
      blankAt(out, i);
      if (i + 1 < n) blankAt(out, i + 1);
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    if (c === '\n') return i;
    blankAt(out, i);
    i++;
  }
  return i;
}

function maskLineComment(source: string, out: string[], start: number): number {
  const n = source.length;
  let i = start + 2;
  while (i < n && source[i] !== '\n') {
    blankAt(out, i);
    i++;
  }
  return i;
}

function maskBlockComment(source: string, out: string[], start: number): number {
  const n = source.length;
  blankAt(out, start);
  blankAt(out, start + 1);
  let i = start + 2;
  while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
    blankAt(out, i);
    i++;
  }
  if (i >= n) return i;
  blankAt(out, i);
  blankAt(out, i + 1);
  return i + 2;
}

function stepTemplate(source: string, out: string[], stack: MaskFrame[], i: number): number {
  const c = source[i];
  if (c === '\\') {
    blankAt(out, i);
    if (i + 1 < source.length) blankAt(out, i + 1);
    return i + 2;
  }
  if (c === '`') {
    stack.pop();
    return i + 1;
  }
  if (c === '$' && source[i + 1] === '{') {
    stack.push({ template: false, brace: 0 });
    return i + 2;
  }
  blankAt(out, i);
  return i + 1;
}

function stepCode(
  source: string,
  out: string[],
  stack: MaskFrame[],
  frame: MaskFrame,
  i: number
): number {
  const c = source[i];
  const next = source[i + 1];
  if (c === '/' && next === '/') return maskLineComment(source, out, i);
  if (c === '/' && next === '*') return maskBlockComment(source, out, i);
  if (c === "'" || c === '"') return maskQuoted(source, out, i);
  if (c === '`') {
    stack.push({ template: true, brace: 0 });
    return i + 1;
  }
  if (c === '{') {
    frame.brace++;
    return i + 1;
  }
  if (c === '}') {
    if (frame.brace === 0 && stack.length > 1) stack.pop();
    else if (frame.brace > 0) frame.brace--;
    return i + 1;
  }
  return i + 1;
}

export function maskStringsAndComments(source: string): string {
  const out = source.split('');
  const n = source.length;
  const stack: MaskFrame[] = [{ template: false, brace: 0 }];
  let i = 0;
  while (i < n) {
    const frame = stack[stack.length - 1];
    i = frame.template
      ? stepTemplate(source, out, stack, i)
      : stepCode(source, out, stack, frame, i);
  }
  return out.join('');
}

export function hasEsmSyntax(source: string): boolean {
  const masked = maskStringsAndComments(source);
  return ESM_IMPORT_RE.test(masked) || ESM_EXPORT_RE.test(masked) || IMPORT_META_RE.test(masked);
}

const DYNAMIC_IMPORT_RE = /\bimport\s*\(/;

export function hasDynamicImport(source: string): boolean {
  return DYNAMIC_IMPORT_RE.test(maskStringsAndComments(source));
}

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

  if (NODE_BUILTINS.has(specifier)) {
    return { type: 'builtin', specifier, name: specifier };
  }

  if (specifier.startsWith('#')) {
    if (specifier === '#' || specifier.startsWith('#/')) {
      throw new Error(`Cannot find module '${specifier}'`);
    }
    const resolved = await resolvePackageImports(specifier, fromDir, reader, conditions);
    if (!resolved) throw new Error(`Cannot find module '${specifier}'`);
    return { type: 'file', path: resolved, moduleKind: await detectModuleKind(reader, resolved) };
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

export interface VfsModuleReaderSource {
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<{ type: string }>;
  readFile(path: string, options?: unknown): Promise<string | Uint8Array>;
}

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
