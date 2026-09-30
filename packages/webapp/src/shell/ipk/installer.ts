/**
 * Install path for ipk (Ice Pack).
 *
 * Resolves `<name>[@<spec>]` install arguments against the npm registry, walks
 * the full transitive dependency graph via `resolveDependencyTree`, downloads
 * each tarball, extracts it into an npm-style `node_modules` layout (compatible
 * duplicates hoisted to the top, conflicting versions nested under the
 * dependent's own `node_modules`), creates `node_modules/.bin` shims for every
 * declared bin (direct AND transitive) without leaving phantom entries for
 * bin-less packages, and records only the directly-requested packages in the
 * package.json section they already occupy (or `devDependencies` with
 * `--save-dev`). Transitive dependencies are NOT promoted.
 *
 * Pure and individually testable: takes an injected `SecureFetch` and
 * `VirtualFS`, so it works in the worker realm across all floats and
 * in unit tests.
 */

import type { SecureFetch } from 'just-bash';
import { type DirEntry, FsError, type VirtualFS } from '../../fs/index.js';
import { joinPath } from '../../fs/path-utils.js';
import {
  allSettledOrThrow,
  createLimiter,
  DEFAULT_FETCH_CONCURRENCY,
  type Limiter,
} from './concurrency.js';
import { EXECUTABLE_MODE, normalizeFileMode } from './file-modes.js';
import {
  preflightGlobalBinDelegators,
  reconcileGlobalBinDelegators,
} from './global-bin-delegators.js';
import { GLOBAL_NODE_MODULES, GLOBAL_NPM_PREFIX, GLOBAL_PACKAGE_JSON } from './global-prefix.js';
import {
  type InstallNode,
  type InstallPlan,
  type PackumentSupplier,
  resolveDependencyTree,
} from './install-plan.js';
import { verifyTarballIntegrity } from './integrity.js';
import { fetchPackument, fetchTarball, type Packument, resolveVersion } from './registry.js';
import { gunzip, readTar, type TarEntry } from './tar.js';

export interface InstallOptions {
  fs: VirtualFS;
  fetch: SecureFetch;
  cwd: string;
  timeoutMs?: number;
  /** Install into `/shared/lib/node_modules` instead of `<cwd>/node_modules`. */
  global?: boolean;
  /** Record named installs in `devDependencies` (npm `--save-dev` / `-D`). */
  saveDev?: boolean;
  /** Packument and tarball fetches in flight at once (default 8). */
  concurrency?: number;
}

export interface InstallResult {
  ok: true;
  name: string;
  version: string;
  installPath: string;
  range: string;
  manifestPath: string;
}

export interface InstallFailure {
  spec: string;
  error: Error;
}

export interface InstallPackagesResult {
  results: InstallResult[];
  errors: InstallFailure[];
  /** Non-fatal messages, e.g. skipped optional dependencies (npm prints them as warnings). */
  notes?: string[];
}

export interface ParsedSpec {
  name: string;
  range: string;
}

export function parseInstallSpec(spec: string): ParsedSpec {
  const trimmed = (spec ?? '').trim();
  if (!trimmed) throw new Error('ipk: package spec is required');

  if (trimmed.startsWith('@')) {
    const slash = trimmed.indexOf('/');
    if (slash === -1) {
      throw new Error(`ipk: scoped spec '${trimmed}' is missing a name (expected @scope/name)`);
    }
    const rest = trimmed.slice(slash + 1);
    const atIdx = rest.indexOf('@');
    const scope = trimmed.slice(0, slash);
    if (atIdx === -1) {
      return { name: `${scope}/${rest}`, range: '' };
    }
    return {
      name: `${scope}/${rest.slice(0, atIdx)}`,
      range: rest.slice(atIdx + 1),
    };
  }

  const atIdx = trimmed.indexOf('@');
  if (atIdx === -1) return { name: trimmed, range: '' };
  return { name: trimmed.slice(0, atIdx), range: trimmed.slice(atIdx + 1) };
}

function packageDirIn(modulesDir: string, pkgName: string): string {
  if (pkgName.startsWith('@')) {
    const [scope, name] = pkgName.split('/', 2);
    return joinPath(modulesDir, scope, name);
  }
  return joinPath(modulesDir, pkgName);
}

async function ensureDir(fs: VirtualFS, path: string): Promise<void> {
  await fs.mkdir(path, { recursive: true });
}

async function removeIfExists(fs: VirtualFS, path: string): Promise<void> {
  if (await fs.exists(path)) {
    await fs.rm(path, { recursive: true });
  }
}

function defaultRange(version: string): string {
  return `^${version}`;
}

function chooseSavedRange(input: ParsedSpec, resolvedVersion: string): string {
  const r = input.range.trim();
  if (r === '' || r === '*' || r === 'latest') return defaultRange(resolvedVersion);
  if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(r)) return defaultRange(resolvedVersion);
  return r;
}

/**
 * Write `entries` under `installDir`, then set every file's mode in one
 * metadata batch: the tar entry's mode normalized as npm does, and 0755 for
 * the package's `bin` targets (npm's bin-links makes them executable too).
 */
async function writeEntries(fs: VirtualFS, installDir: string, entries: TarEntry[]): Promise<void> {
  const modes = new Map<string, number>();
  for (const entry of entries) {
    if (!entry.path) continue;
    const safePath = entry.path.replace(/\\/g, '/').replace(/^\/+/, '');
    if (safePath.split('/').some((seg) => seg === '..')) {
      throw new Error(`installer: refusing to extract entry escaping package root: ${entry.path}`);
    }
    const target = joinPath(installDir, safePath);
    const lastSlash = target.lastIndexOf('/');
    if (lastSlash > 0) {
      await ensureDir(fs, target.slice(0, lastSlash));
    }
    await fs.writeFile(target, entry.bytes);
    modes.set(safePath, normalizeFileMode(entry.mode));
  }
  for (const binPath of binTargets(entries)) {
    if (modes.has(binPath)) modes.set(binPath, EXECUTABLE_MODE);
  }
  await fs.updateMetadataBatch(
    [...modes].map(([path, mode]) => ({ path: joinPath(installDir, path), mode }))
  );
}

/** Package-relative paths of the `bin` targets declared in the tarball's package.json. */
function binTargets(entries: TarEntry[]): string[] {
  const manifestEntry = entries.find((e) => e.path === 'package.json');
  if (!manifestEntry) return [];
  let manifest: InstalledPackageManifest;
  try {
    manifest = JSON.parse(
      new TextDecoder().decode(manifestEntry.bytes)
    ) as InstalledPackageManifest;
  } catch {
    return [];
  }
  const bin = manifest.bin;
  if (typeof bin !== 'string' && (typeof bin !== 'object' || bin === null)) return [];
  return Object.values(normalizeBin(bin, manifest.name ?? ''))
    .filter((p): p is string => typeof p === 'string')
    .map(normalizeBinPath);
}

/** ENOENT → fallback; any other FsError or JSON parse fault is rethrown. */
async function readJsonOr<T>(fs: VirtualFS, path: string, fallback: T): Promise<T> {
  let text: string;
  try {
    text = (await fs.readFile(path)) as string;
  } catch (err) {
    if (err instanceof FsError && err.code === 'ENOENT') return fallback;
    throw err;
  }
  return JSON.parse(text) as T;
}

/**
 * Reader for installer-owned files under `node_modules`: missing, empty, or
 * unparseable JSON is the fallback so extract / list / bin-walk can self-heal.
 * Non-ENOENT FsError still propagates.
 */
async function readInstalledJsonOr<T>(fs: VirtualFS, path: string, fallback: T): Promise<T> {
  let text: string;
  try {
    text = (await fs.readFile(path)) as string;
  } catch (err) {
    if (err instanceof FsError && err.code === 'ENOENT') return fallback;
    throw err;
  }
  if (!text?.trim()) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/**
 * Root names the manifest declares under `optionalDependencies`, minus
 * `explicit` ones the user just named: those install like any other.
 */
function optionalRootNames(
  manifest: ProjectManifest,
  explicit: Iterable<string> = []
): Set<string> {
  const names = new Set(Object.keys(manifest.optionalDependencies ?? {}));
  for (const name of explicit) names.delete(name);
  return names;
}

function skipNotes(plan: InstallPlan): string[] {
  return plan.skippedOptional.map((s) => s.note);
}

interface ProjectManifest {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  [key: string]: unknown;
}

type DependencySection =
  | 'dependencies'
  | 'devDependencies'
  | 'optionalDependencies'
  | 'peerDependencies';

const DEPENDENCY_SECTIONS: readonly DependencySection[] = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];

function bagHasName(
  bag: Record<string, string> | undefined,
  name: string
): bag is Record<string, string> {
  return bag !== undefined && Object.hasOwn(bag, name);
}

/**
 * Section a named install should update. Prefer the more specific existing
 * section so a package already in `devDependencies` is not duplicated under
 * `dependencies` (#2925). `--save-dev` always targets `devDependencies`.
 */
function chooseSaveSection(
  manifest: ProjectManifest,
  name: string,
  saveDev: boolean
): DependencySection {
  if (saveDev) return 'devDependencies';
  if (bagHasName(manifest.devDependencies, name)) return 'devDependencies';
  if (bagHasName(manifest.optionalDependencies, name)) return 'optionalDependencies';
  if (bagHasName(manifest.peerDependencies, name)) return 'peerDependencies';
  return 'dependencies';
}

function declaredRange(manifest: ProjectManifest, name: string): string | undefined {
  const section = chooseSaveSection(manifest, name, false);
  const range = manifest[section]?.[name];
  return typeof range === 'string' && range.trim() !== '' ? range : undefined;
}

function applyDeclaredRange(parsed: ParsedSpec, manifest: ProjectManifest): ParsedSpec {
  if (parsed.range.trim() !== '') return parsed;
  const existing = declaredRange(manifest, parsed.name);
  if (existing === undefined) return parsed;
  return { name: parsed.name, range: existing };
}

function writeDirectDependencies(
  existing: ProjectManifest,
  entries: Array<{ name: string; range: string; section: DependencySection }>
): ProjectManifest {
  const bags: Record<DependencySection, Record<string, string>> = {
    dependencies: { ...(existing.dependencies ?? {}) },
    devDependencies: { ...(existing.devDependencies ?? {}) },
    optionalDependencies: { ...(existing.optionalDependencies ?? {}) },
    peerDependencies: { ...(existing.peerDependencies ?? {}) },
  };
  const written = new Set<DependencySection>();
  for (const entry of entries) {
    for (const section of DEPENDENCY_SECTIONS) {
      delete bags[section][entry.name];
    }
    bags[entry.section][entry.name] = entry.range;
    written.add(entry.section);
  }
  const next: ProjectManifest = { ...existing };
  for (const section of DEPENDENCY_SECTIONS) {
    if (existing[section] !== undefined || written.has(section)) {
      next[section] = bags[section];
    }
  }
  return next;
}

interface InstalledPackageManifest {
  name?: string;
  bin?: string | Record<string, string>;
  [key: string]: unknown;
}

/**
 * Memoized packument fetcher shared by root staging and tree resolution.
 * Caches the in-flight promise, so concurrent requests for one name share a
 * fetch; a failed fetch is forgotten so a later request can retry it.
 */
function buildPackumentSupplier(fetch: SecureFetch, timeoutMs?: number): PackumentSupplier {
  const cache = new Map<string, Promise<Packument>>();
  return (name: string) => {
    let cached = cache.get(name);
    if (!cached) {
      cached = fetchPackument(name, fetch, { timeoutMs });
      cache.set(name, cached);
      cached.catch(() => cache.delete(name));
    }
    return cached;
  };
}

/**
 * Start fetching `names` in the background, at most `concurrency` at a time,
 * so the sequential validation loops that follow find them cached. Errors are
 * left for those loops to report.
 */
function warmPackuments(supplier: PackumentSupplier, names: string[], concurrency?: number): void {
  const limit = createLimiter(concurrency ?? DEFAULT_FETCH_CONCURRENCY);
  for (const name of new Set(names)) {
    limit(async () => supplier(name)).catch(() => undefined);
  }
}

interface ResolvedDirect {
  spec: string;
  parsed: ParsedSpec;
}

async function stageResolveRoots(
  specs: string[],
  supplier: PackumentSupplier,
  existingManifest?: ProjectManifest,
  concurrency?: number
): Promise<{ directs: ResolvedDirect[]; errors: InstallFailure[] }> {
  const directs: ResolvedDirect[] = [];
  const errors: InstallFailure[] = [];
  const seen = new Set<string>();
  const names: string[] = [];
  for (const spec of specs) {
    try {
      names.push(parseInstallSpec(spec).name);
    } catch {
      // Reported by the loop below.
    }
  }
  warmPackuments(supplier, names, concurrency);

  for (const spec of specs) {
    let parsed: ParsedSpec;
    try {
      parsed = parseInstallSpec(spec);
    } catch (err) {
      errors.push({ spec, error: toError(err) });
      continue;
    }
    if (existingManifest) {
      parsed = applyDeclaredRange(parsed, existingManifest);
    }
    if (seen.has(parsed.name)) {
      // Later specs for the same name override earlier ones.
      const idx = directs.findIndex((d) => d.parsed.name === parsed.name);
      if (idx >= 0) directs.splice(idx, 1);
    }
    try {
      const packument = await supplier(parsed.name);
      resolveVersion(packument, parsed.range);
    } catch (err) {
      errors.push({ spec, error: toError(err) });
      continue;
    }
    directs.push({ spec, parsed });
    seen.add(parsed.name);
  }

  return { directs, errors };
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

interface MaterializeContext {
  fs: VirtualFS;
  fetch: SecureFetch;
  timeoutMs: number | undefined;
  /** Bounds tarballs in flight (and so in memory) at once. */
  limit: Limiter;
  /** Set on the first failure so queued packages are skipped, not started. */
  failed: boolean;
  /**
   * The tree predates file modes being applied (no {@link MODES_MARKER}):
   * re-extract packages whose version already matches, once, so their
   * executable bits are repaired.
   */
  reextractMatching: boolean;
}

/**
 * Written at a `node_modules` root once every package in it was extracted
 * with its file modes applied. Trees installed before that dropped every
 * executable bit, so an install into a tree without it re-extracts even
 * matching versions. A dotfile, so package listing and bin walks ignore it.
 */
const MODES_MARKER = '.ipk-modes-v1';

/** Fetch, verify and extract `node` into `installDir` unless that version is already there. */
async function installNodeFiles(
  ctx: MaterializeContext,
  installDir: string,
  node: InstallNode
): Promise<void> {
  const { fs } = ctx;
  const installedManifestPath = joinPath(installDir, 'package.json');
  if (await fs.exists(installedManifestPath)) {
    const installed = await readInstalledJsonOr<InstalledPackageManifest | null>(
      fs,
      installedManifestPath,
      null
    );
    if (installed?.version === node.version && !ctx.reextractMatching) return;
  }

  const tarballBytes = await fetchTarball(node.resolved, ctx.fetch, { timeoutMs: ctx.timeoutMs });
  await verifyTarballIntegrity(tarballBytes, node, `${node.name}@${node.version}`);
  const entries = readTar(gunzip(tarballBytes));

  await removeIfExists(fs, installDir);
  await ensureDir(fs, installDir);
  try {
    await writeEntries(fs, installDir, entries);
  } catch (err) {
    await removeIfExists(fs, installDir);
    throw err;
  }
}

/**
 * Materialize `node`, then its nested dependencies. A package is extracted
 * before anything nested inside it, because extracting replaces its whole
 * directory; siblings (disjoint directories) proceed concurrently.
 */
async function materializeNode(
  ctx: MaterializeContext,
  parentModulesDir: string,
  node: InstallNode
): Promise<void> {
  const installDir = packageDirIn(parentModulesDir, node.name);
  await ctx.limit(async () => {
    if (ctx.failed) return;
    try {
      await installNodeFiles(ctx, installDir, node);
    } catch (err) {
      ctx.failed = true;
      throw err;
    }
  });

  const nestedNames = Object.keys(node.dependencies);
  if (nestedNames.length === 0 || ctx.failed) return;
  const childModulesDir = joinPath(installDir, 'node_modules');
  await ensureDir(ctx.fs, childModulesDir);
  await allSettledOrThrow(
    nestedNames.map((childName) =>
      materializeNode(ctx, childModulesDir, node.dependencies[childName])
    )
  );
}

async function materializePlan(
  fs: VirtualFS,
  modulesDir: string,
  plan: InstallPlan,
  fetch: SecureFetch,
  timeoutMs: number | undefined,
  concurrency?: number
): Promise<void> {
  const topNames = Object.keys(plan.root);
  if (topNames.length === 0) return;
  await ensureDir(fs, modulesDir);
  const markerPath = joinPath(modulesDir, MODES_MARKER);
  const ctx: MaterializeContext = {
    fs,
    fetch,
    timeoutMs,
    limit: createLimiter(concurrency ?? DEFAULT_FETCH_CONCURRENCY),
    failed: false,
    reextractMatching: !(await fs.exists(markerPath)),
  };
  await allSettledOrThrow(
    topNames.map((name) => materializeNode(ctx, modulesDir, plan.root[name]))
  );
  if (ctx.reextractMatching) await fs.writeFile(markerPath, '');
}

function unscopedName(pkgName: string): string {
  if (pkgName.startsWith('@')) {
    const slash = pkgName.indexOf('/');
    if (slash !== -1) return pkgName.slice(slash + 1);
  }
  return pkgName;
}

function normalizeBin(
  bin: string | Record<string, string>,
  pkgName: string
): Record<string, string> {
  if (typeof bin === 'string') {
    return { [unscopedName(pkgName)]: bin };
  }
  return bin;
}

function normalizeBinPath(p: string): string {
  return p.replace(/^\.\//, '').replace(/^\/+/, '');
}

function buildShimFromTarget(target: string): string {
  return `#!/usr/bin/env node\nrequire(${JSON.stringify(target)});\n`;
}

interface InstalledBin {
  binName: string;
  pkgName: string;
  installDir: string;
  binPath: string;
  depth: number;
}

async function collectInstalledBins(fs: VirtualFS, modulesDir: string): Promise<InstalledBin[]> {
  const out: InstalledBin[] = [];
  await walkNodeModules(fs, modulesDir, 0, out);
  return out;
}

async function walkNodeModules(
  fs: VirtualFS,
  dir: string,
  depth: number,
  out: InstalledBin[]
): Promise<void> {
  if (!(await fs.exists(dir))) return;
  let dirEntries: DirEntry[];
  try {
    dirEntries = await fs.readDir(dir);
  } catch {
    return;
  }
  for (const entry of dirEntries) {
    if (entry.type !== 'directory') continue;
    if (entry.name === '.bin') continue;
    if (entry.name.startsWith('@')) {
      const scopeDir = joinPath(dir, entry.name);
      let scopeEntries: DirEntry[];
      try {
        scopeEntries = await fs.readDir(scopeDir);
      } catch {
        continue;
      }
      for (const sub of scopeEntries) {
        if (sub.type !== 'directory') continue;
        const pkgName = `${entry.name}/${sub.name}`;
        const pkgDir = joinPath(scopeDir, sub.name);
        await collectFromPackage(fs, pkgDir, pkgName, depth, out);
      }
      continue;
    }
    const pkgName = entry.name;
    const pkgDir = joinPath(dir, entry.name);
    await collectFromPackage(fs, pkgDir, pkgName, depth, out);
  }
}

async function collectFromPackage(
  fs: VirtualFS,
  pkgDir: string,
  pkgName: string,
  depth: number,
  out: InstalledBin[]
): Promise<void> {
  const manifest = await readInstalledJsonOr<InstalledPackageManifest | null>(
    fs,
    joinPath(pkgDir, 'package.json'),
    null
  );
  if (manifest?.bin !== undefined && manifest.bin !== null) {
    const bins = normalizeBin(manifest.bin, pkgName);
    for (const [binName, binPath] of Object.entries(bins)) {
      if (typeof binName !== 'string' || binName.length === 0) continue;
      if (typeof binPath !== 'string' || binPath.length === 0) continue;
      out.push({ binName, pkgName, installDir: pkgDir, binPath, depth });
    }
  }
  const nestedModulesDir = joinPath(pkgDir, 'node_modules');
  await walkNodeModules(fs, nestedModulesDir, depth + 1, out);
}

function chooseRootBins(bins: InstalledBin[]): Map<string, InstalledBin> {
  const chosen = new Map<string, InstalledBin>();
  for (const e of bins) {
    const cur = chosen.get(e.binName);
    if (!cur) {
      chosen.set(e.binName, e);
      continue;
    }
    if (e.depth < cur.depth) {
      chosen.set(e.binName, e);
    } else if (e.depth === cur.depth && e.pkgName < cur.pkgName) {
      chosen.set(e.binName, e);
    }
  }
  return chosen;
}

function walkPlanBins(
  modulesDir: string,
  node: InstallNode,
  depth: number,
  out: InstalledBin[]
): void {
  const installDir = packageDirIn(modulesDir, node.name);
  if (node.bin !== undefined && node.bin !== null) {
    const bins = normalizeBin(node.bin, node.name);
    for (const [binName, binPath] of Object.entries(bins)) {
      if (typeof binName !== 'string' || binName.length === 0) continue;
      if (typeof binPath !== 'string' || binPath.length === 0) continue;
      out.push({ binName, pkgName: node.name, installDir, binPath, depth });
    }
  }
  const nestedModulesDir = joinPath(installDir, 'node_modules');
  for (const child of Object.values(node.dependencies)) {
    walkPlanBins(nestedModulesDir, child, depth + 1, out);
  }
}

function collectBinsFromPlan(plan: InstallPlan, modulesDir: string): InstalledBin[] {
  const out: InstalledBin[] = [];
  for (const node of Object.values(plan.root)) {
    walkPlanBins(modulesDir, node, 0, out);
  }
  return out;
}

function predictGlobalBinNames(plan: InstallPlan, modulesDir: string): Set<string> {
  return new Set(chooseRootBins(collectBinsFromPlan(plan, modulesDir)).keys());
}

function shimTargetFor(modulesDir: string, installDir: string, binPath: string): string {
  const rel = installDir.slice(modulesDir.length);
  return `..${rel}/${normalizeBinPath(binPath)}`;
}

async function reconcileRootBinShims(fs: VirtualFS, modulesDir: string): Promise<void> {
  const installed = await collectInstalledBins(fs, modulesDir);
  const chosen = chooseRootBins(installed);

  const binDir = joinPath(modulesDir, '.bin');
  const binDirExists = await fs.exists(binDir);

  if (binDirExists) {
    let existing: DirEntry[];
    try {
      existing = await fs.readDir(binDir);
    } catch {
      existing = [];
    }
    for (const entry of existing) {
      if (entry.type !== 'file') continue;
      if (chosen.has(entry.name)) continue;
      await fs.rm(joinPath(binDir, entry.name));
    }
  }

  if (chosen.size === 0) return;

  await ensureDir(fs, binDir);
  for (const target of chosen.values()) {
    const shimPath = joinPath(binDir, target.binName);
    const shim = buildShimFromTarget(shimTargetFor(modulesDir, target.installDir, target.binPath));
    await fs.writeFile(shimPath, shim);
  }
}

async function recordDirectDependencies(
  fs: VirtualFS,
  cwd: string,
  entries: Array<{ name: string; range: string; section: DependencySection }>
): Promise<string> {
  const manifestPath = joinPath(cwd, 'package.json');
  const existing = await readJsonOr<ProjectManifest>(fs, manifestPath, {});
  const next = writeDirectDependencies(existing, entries);
  await fs.writeFile(manifestPath, `${JSON.stringify(next, null, 2)}\n`);
  return manifestPath;
}

export async function installPackages(
  specs: string[],
  options: InstallOptions
): Promise<InstallPackagesResult> {
  const {
    fs,
    fetch,
    cwd,
    timeoutMs,
    global: globalInstall = false,
    saveDev = false,
    concurrency,
  } = options;
  if (specs.length === 0) {
    return { results: [], errors: [] };
  }

  const manifestRoot = globalInstall ? GLOBAL_NPM_PREFIX : cwd;
  const existingManifest = await readJsonOr<ProjectManifest>(
    fs,
    joinPath(manifestRoot, 'package.json'),
    {}
  );

  const supplier = buildPackumentSupplier(fetch, timeoutMs);
  const { directs, errors: stageErrors } = await stageResolveRoots(
    specs,
    supplier,
    existingManifest,
    concurrency
  );
  if (directs.length === 0) {
    return { results: [], errors: stageErrors };
  }

  const rootDependencies: Record<string, string> = {};
  if (globalInstall) {
    for (const entry of collectManagedEntries(existingManifest)) {
      rootDependencies[entry.name] = entry.range;
    }
  }
  for (const direct of directs) {
    rootDependencies[direct.parsed.name] = direct.parsed.range;
  }

  const plan = await resolveDependencyTree({
    rootDependencies,
    fetchPackument: supplier,
    concurrency,
    optionalRoots: optionalRootNames(
      existingManifest,
      directs.map((d) => d.parsed.name)
    ),
  });

  const modulesDir = globalInstall ? GLOBAL_NODE_MODULES : joinPath(cwd, 'node_modules');
  if (globalInstall) {
    await pruneTopLevelPackages(fs, modulesDir, new Set(Object.keys(plan.root)));
    await preflightGlobalBinDelegators(fs, predictGlobalBinNames(plan, modulesDir));
  }
  await materializePlan(fs, modulesDir, plan, fetch, timeoutMs, concurrency);
  await reconcileRootBinShims(fs, modulesDir);
  if (globalInstall) {
    const installed = await collectInstalledBins(fs, modulesDir);
    const chosen = chooseRootBins(installed);
    await reconcileGlobalBinDelegators(fs, new Set(chosen.keys()));
  }

  const records = directs.map((d) => {
    const node = plan.root[d.parsed.name];
    if (!node) throw new Error(`installer: resolved node missing for ${d.parsed.name}`);
    return {
      name: d.parsed.name,
      range: chooseSavedRange(d.parsed, node.version),
      section: chooseSaveSection(existingManifest, d.parsed.name, saveDev),
    };
  });
  const manifestPath = await recordDirectDependencies(fs, manifestRoot, records);

  const results: InstallResult[] = directs.map((d) => {
    const node = plan.root[d.parsed.name];
    const installPath = packageDirIn(modulesDir, d.parsed.name);
    return {
      ok: true,
      name: d.parsed.name,
      version: node.version,
      installPath,
      range: chooseSavedRange(d.parsed, node.version),
      manifestPath,
    };
  });

  return { results, errors: stageErrors, notes: skipNotes(plan) };
}

export async function installPackage(
  spec: string,
  options: InstallOptions
): Promise<InstallResult> {
  const { results, errors } = await installPackages([spec], options);
  if (errors.length > 0) throw errors[0].error;
  if (results.length === 0) {
    throw new Error(`ipk: install of '${spec}' produced no result`);
  }
  return results[0];
}

export interface InstallFromManifestResult {
  results: InstallResult[];
  errors: InstallFailure[];
  empty: boolean;
  /** Non-fatal messages, e.g. skipped optional dependencies. */
  notes?: string[];
}

export class ManifestNotFoundError extends Error {
  constructor(manifestPath: string) {
    super(
      `no package.json found at ${manifestPath} (run 'ipk install <pkg>' to create one, or add a package.json)`
    );
    this.name = 'ManifestNotFoundError';
  }
}

interface ManifestEntry {
  name: string;
  range: string;
}

function addNamedRanges(
  combined: Map<string, string>,
  bag: Record<string, string> | undefined
): void {
  if (!bag || typeof bag !== 'object') return;
  for (const [name, range] of Object.entries(bag)) {
    if (typeof name === 'string' && typeof range === 'string') {
      combined.set(name, range);
    }
  }
}

/**
 * No-arg `ipk install` still reads only dependencies + devDependencies so that
 * path stays non-destructive and does not start installing optional/peer.
 * Later bags overwrite earlier ones (dependencies win over devDependencies).
 */
function collectManifestEntries(manifest: ProjectManifest): ManifestEntry[] {
  const combined = new Map<string, string>();
  addNamedRanges(combined, manifest.devDependencies);
  addNamedRanges(combined, manifest.dependencies);
  // Last, so a name also listed elsewhere is optional, as npm treats it.
  addNamedRanges(combined, manifest.optionalDependencies);
  return Array.from(combined.entries()).map(([name, range]) => ({ name, range }));
}

/**
 * Direct ranges for tree planning and listing: every section named installs
 * may write to. Preference matches `chooseSaveSection` (dev > optional >
 * peer > dependencies) so a later bag overwrites an earlier one.
 */
function collectManagedEntries(manifest: ProjectManifest): ManifestEntry[] {
  const combined = new Map<string, string>();
  addNamedRanges(combined, manifest.dependencies);
  addNamedRanges(combined, manifest.peerDependencies);
  addNamedRanges(combined, manifest.optionalDependencies);
  addNamedRanges(combined, manifest.devDependencies);
  return Array.from(combined.entries()).map(([name, range]) => ({ name, range }));
}

export async function installFromManifest(
  options: InstallOptions
): Promise<InstallFromManifestResult> {
  const { fs, fetch, cwd, timeoutMs, concurrency } = options;
  const manifestPath = joinPath(cwd, 'package.json');
  if (!(await fs.exists(manifestPath))) {
    throw new ManifestNotFoundError(manifestPath);
  }
  const manifest = await readJsonOr<ProjectManifest>(fs, manifestPath, {});
  const entries = collectManifestEntries(manifest);
  if (entries.length === 0) {
    return { results: [], errors: [], empty: true };
  }

  const supplier = buildPackumentSupplier(fetch, timeoutMs);

  const validated: ManifestEntry[] = [];
  const errors: InstallFailure[] = [];
  const optionalRoots = optionalRootNames(manifest);
  const notes: string[] = [];
  warmPackuments(
    supplier,
    entries.map((entry) => entry.name),
    concurrency
  );
  for (const entry of entries) {
    try {
      const packument = await supplier(entry.name);
      resolveVersion(packument, entry.range);
      validated.push(entry);
    } catch (err) {
      if (optionalRoots.has(entry.name)) {
        notes.push(
          `skipping optional dependency ${entry.name}@${entry.range} (${toError(err).message})`
        );
      } else {
        errors.push({ spec: `${entry.name}@${entry.range}`, error: toError(err) });
      }
    }
  }

  if (validated.length === 0) {
    return { results: [], errors, empty: false, notes };
  }

  const rootDependencies: Record<string, string> = {};
  for (const entry of validated) {
    rootDependencies[entry.name] = entry.range;
  }

  const plan = await resolveDependencyTree({
    rootDependencies,
    fetchPackument: supplier,
    concurrency,
    optionalRoots,
  });

  const modulesDir = joinPath(cwd, 'node_modules');
  await materializePlan(fs, modulesDir, plan, fetch, timeoutMs, concurrency);
  await reconcileRootBinShims(fs, modulesDir);

  const results: InstallResult[] = validated
    .map((entry) => {
      const node = plan.root[entry.name];
      if (!node) return null;
      return {
        ok: true as const,
        name: entry.name,
        version: node.version,
        installPath: packageDirIn(modulesDir, entry.name),
        range: entry.range,
        manifestPath,
      } satisfies InstallResult;
    })
    .filter((r): r is InstallResult => r !== null);

  return { results, errors, empty: false, notes: [...notes, ...skipNotes(plan)] };
}

function packageListedInManifest(manifest: ProjectManifest, name: string): boolean {
  return DEPENDENCY_SECTIONS.some((section) => bagHasName(manifest[section], name));
}

function manifestWithoutPackages(
  manifest: ProjectManifest,
  names: ReadonlySet<string>
): ProjectManifest {
  const next: ProjectManifest = { ...manifest };
  for (const section of DEPENDENCY_SECTIONS) {
    const bag = { ...(manifest[section] ?? {}) };
    for (const name of names) {
      delete bag[name];
    }
    if (manifest[section] !== undefined) {
      next[section] = bag;
    }
  }
  return next;
}

async function writeManifest(
  fs: VirtualFS,
  manifestPath: string,
  manifest: ProjectManifest
): Promise<void> {
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function pruneTopLevelPackages(
  fs: VirtualFS,
  modulesDir: string,
  keepTopLevel: ReadonlySet<string>
): Promise<void> {
  if (!(await fs.exists(modulesDir))) return;
  let dirEntries: DirEntry[];
  try {
    dirEntries = await fs.readDir(modulesDir);
  } catch {
    return;
  }
  for (const entry of dirEntries) {
    if (entry.name === '.bin') continue;
    if (entry.type !== 'directory') continue;
    if (entry.name.startsWith('@')) {
      const scopeDir = joinPath(modulesDir, entry.name);
      let scopeEntries: DirEntry[];
      try {
        scopeEntries = await fs.readDir(scopeDir);
      } catch {
        continue;
      }
      for (const sub of scopeEntries) {
        if (sub.type !== 'directory') continue;
        const pkgName = `${entry.name}/${sub.name}`;
        if (!keepTopLevel.has(pkgName)) {
          await removeIfExists(fs, joinPath(scopeDir, sub.name));
        }
      }
      continue;
    }
    if (!keepTopLevel.has(entry.name)) {
      await removeIfExists(fs, joinPath(modulesDir, entry.name));
    }
  }
}

/**
 * Reconcile the global install tree with `/shared/lib/package.json` direct
 * dependencies: resolve the merged graph, prune orphaned top-level packages,
 * materialize, and refresh bin shims + PATH delegators.
 */
export async function syncGlobalInstallTree(
  fs: VirtualFS,
  fetch: SecureFetch,
  timeoutMs?: number,
  manifestOverride?: ProjectManifest
): Promise<void> {
  const manifest =
    manifestOverride ?? (await readJsonOr<ProjectManifest>(fs, GLOBAL_PACKAGE_JSON, {}));
  const entries = collectManagedEntries(manifest);

  if (entries.length === 0) {
    await removeIfExists(fs, GLOBAL_NODE_MODULES);
    await reconcileGlobalBinDelegators(fs, new Set());
    return;
  }

  const supplier = buildPackumentSupplier(fetch, timeoutMs);
  const rootDependencies: Record<string, string> = {};
  for (const entry of entries) {
    rootDependencies[entry.name] = entry.range;
  }

  const plan = await resolveDependencyTree({
    rootDependencies,
    fetchPackument: supplier,
    optionalRoots: optionalRootNames(manifest),
  });

  await pruneTopLevelPackages(fs, GLOBAL_NODE_MODULES, new Set(Object.keys(plan.root)));
  await preflightGlobalBinDelegators(fs, predictGlobalBinNames(plan, GLOBAL_NODE_MODULES));
  await materializePlan(fs, GLOBAL_NODE_MODULES, plan, fetch, timeoutMs);
  await reconcileRootBinShims(fs, GLOBAL_NODE_MODULES);
  const installed = await collectInstalledBins(fs, GLOBAL_NODE_MODULES);
  const chosen = chooseRootBins(installed);
  await reconcileGlobalBinDelegators(fs, new Set(chosen.keys()));
}

export interface UninstallResult {
  name: string;
  removed: boolean;
}

export interface UninstallPackagesResult {
  results: UninstallResult[];
  errors: InstallFailure[];
}

export async function uninstallPackages(
  specs: string[],
  options: InstallOptions
): Promise<UninstallPackagesResult> {
  const { fs, fetch, cwd, timeoutMs, global: globalUninstall = false } = options;
  if (specs.length === 0) {
    return { results: [], errors: [] };
  }

  const names = new Set<string>();
  const errors: InstallFailure[] = [];
  for (const spec of specs) {
    try {
      names.add(parseInstallSpec(spec).name);
    } catch (err) {
      errors.push({ spec, error: toError(err) });
    }
  }
  if (names.size === 0) {
    return { results: [], errors };
  }

  const manifestRoot = globalUninstall ? GLOBAL_NPM_PREFIX : cwd;
  const manifestPath = joinPath(manifestRoot, 'package.json');
  if (!(await fs.exists(manifestPath))) {
    for (const spec of specs) {
      errors.push({
        spec,
        error: new ManifestNotFoundError(manifestPath),
      });
    }
    return { results: [], errors };
  }

  const before = await readJsonOr<ProjectManifest>(fs, manifestPath, {});
  const results: UninstallResult[] = [];
  for (const name of names) {
    results.push({ name, removed: packageListedInManifest(before, name) });
  }

  const nextManifest = manifestWithoutPackages(before, names);

  try {
    if (globalUninstall) {
      await syncGlobalInstallTree(fs, fetch, timeoutMs, nextManifest);
    } else {
      await syncLocalInstallTree(fs, fetch, cwd, timeoutMs, nextManifest);
    }
  } catch (err) {
    errors.push({ spec: specs.join(' '), error: toError(err) });
    return { results, errors };
  }

  await writeManifest(fs, manifestPath, nextManifest);

  return { results, errors };
}

async function syncLocalInstallTree(
  fs: VirtualFS,
  fetch: SecureFetch,
  cwd: string,
  timeoutMs?: number,
  manifestOverride?: ProjectManifest
): Promise<void> {
  const manifestPath = joinPath(cwd, 'package.json');
  const manifest = manifestOverride ?? (await readJsonOr<ProjectManifest>(fs, manifestPath, {}));
  const entries = collectManagedEntries(manifest);
  const modulesDir = joinPath(cwd, 'node_modules');

  if (entries.length === 0) {
    await removeIfExists(fs, modulesDir);
    return;
  }

  const supplier = buildPackumentSupplier(fetch, timeoutMs);
  const rootDependencies: Record<string, string> = {};
  for (const entry of entries) {
    rootDependencies[entry.name] = entry.range;
  }

  const plan = await resolveDependencyTree({
    rootDependencies,
    fetchPackument: supplier,
    optionalRoots: optionalRootNames(manifest),
  });

  await pruneTopLevelPackages(fs, modulesDir, new Set(Object.keys(plan.root)));
  await materializePlan(fs, modulesDir, plan, fetch, timeoutMs);
  await reconcileRootBinShims(fs, modulesDir);
}

export interface GlobalPackageListing {
  name: string;
  version: string;
  range: string;
}

export async function listGlobalPackages(fs: VirtualFS): Promise<GlobalPackageListing[]> {
  const manifest = await readJsonOr<ProjectManifest>(fs, GLOBAL_PACKAGE_JSON, {});
  const entries = collectManagedEntries(manifest);
  const out: GlobalPackageListing[] = [];
  for (const entry of entries) {
    const installedPath = joinPath(packageDirIn(GLOBAL_NODE_MODULES, entry.name), 'package.json');
    const installed = await readInstalledJsonOr<{ version?: string }>(fs, installedPath, {});
    out.push({
      name: entry.name,
      version: typeof installed.version === 'string' ? installed.version : '?',
      range: entry.range,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export async function listLocalPackages(
  fs: VirtualFS,
  cwd: string
): Promise<GlobalPackageListing[]> {
  const manifestPath = joinPath(cwd, 'package.json');
  if (!(await fs.exists(manifestPath))) return [];
  const manifest = await readJsonOr<ProjectManifest>(fs, manifestPath, {});
  const entries = collectManagedEntries(manifest);
  const modulesDir = joinPath(cwd, 'node_modules');
  const out: GlobalPackageListing[] = [];
  for (const entry of entries) {
    const installedPath = joinPath(packageDirIn(modulesDir, entry.name), 'package.json');
    const installed = await readInstalledJsonOr<{ version?: string }>(fs, installedPath, {});
    out.push({
      name: entry.name,
      version: typeof installed.version === 'string' ? installed.version : '?',
      range: entry.range,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
