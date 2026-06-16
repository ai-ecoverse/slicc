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
 * project `package.json` (transitive dependencies are NOT promoted).
 *
 * Pure and individually testable: takes an injected `SecureFetch` and
 * `VirtualFS`, so it works in both floats (CLI worker + extension sandbox) and
 * in unit tests.
 */

import type { SecureFetch } from 'just-bash';
import type { DirEntry, VirtualFS } from '../../fs/index.js';
import { fetchPackument, fetchTarball, type Packument, resolveVersion } from './registry.js';
import {
  type InstallNode,
  type InstallPlan,
  type PackumentSupplier,
  resolveDependencyTree,
} from './resolver.js';
import { gunzip, readTar, type TarEntry } from './tar.js';

export interface InstallOptions {
  fs: VirtualFS;
  fetch: SecureFetch;
  cwd: string;
  timeoutMs?: number;
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

function joinPath(base: string, ...parts: string[]): string {
  const segments = [base, ...parts]
    .join('/')
    .split('/')
    .filter((p) => p.length > 0);
  return `/${segments.join('/')}`;
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

async function writeEntries(fs: VirtualFS, installDir: string, entries: TarEntry[]): Promise<void> {
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
  }
}

async function readJsonOr<T>(fs: VirtualFS, path: string, fallback: T): Promise<T> {
  if (!(await fs.exists(path))) return fallback;
  let text: string;
  try {
    text = (await fs.readFile(path)) as string;
  } catch {
    return fallback;
  }
  if (!text?.trim()) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

interface ProjectManifest {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [key: string]: unknown;
}

interface InstalledPackageManifest {
  name?: string;
  bin?: string | Record<string, string>;
  [key: string]: unknown;
}

function buildPackumentSupplier(
  fetch: SecureFetch,
  timeoutMs?: number
): { supplier: PackumentSupplier; cache: Map<string, Packument> } {
  const cache = new Map<string, Packument>();
  const supplier: PackumentSupplier = async (name: string) => {
    let cached = cache.get(name);
    if (cached) return cached;
    cached = await fetchPackument(name, fetch, { timeoutMs });
    cache.set(name, cached);
    return cached;
  };
  return { supplier, cache };
}

interface ResolvedDirect {
  spec: string;
  parsed: ParsedSpec;
}

async function stageResolveRoots(
  specs: string[],
  supplier: PackumentSupplier
): Promise<{ directs: ResolvedDirect[]; errors: InstallFailure[] }> {
  const directs: ResolvedDirect[] = [];
  const errors: InstallFailure[] = [];
  const seen = new Set<string>();

  for (const spec of specs) {
    let parsed: ParsedSpec;
    try {
      parsed = parseInstallSpec(spec);
    } catch (err) {
      errors.push({ spec, error: toError(err) });
      continue;
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

async function materializeNode(
  fs: VirtualFS,
  parentModulesDir: string,
  node: InstallNode,
  fetch: SecureFetch,
  timeoutMs: number | undefined
): Promise<void> {
  const installDir = packageDirIn(parentModulesDir, node.name);
  const installedManifestPath = joinPath(installDir, 'package.json');
  let alreadySatisfied = false;
  if (await fs.exists(installedManifestPath)) {
    const installed = await readJsonOr<InstalledPackageManifest | null>(
      fs,
      installedManifestPath,
      null
    );
    if (installed?.version === node.version) {
      alreadySatisfied = true;
    }
  }

  if (!alreadySatisfied) {
    const tarballBytes = await fetchTarball(node.resolved, fetch, { timeoutMs });
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

  const nestedNames = Object.keys(node.dependencies);
  if (nestedNames.length > 0) {
    const childModulesDir = joinPath(installDir, 'node_modules');
    await ensureDir(fs, childModulesDir);
    for (const childName of nestedNames) {
      await materializeNode(fs, childModulesDir, node.dependencies[childName], fetch, timeoutMs);
    }
  }
}

async function materializePlan(
  fs: VirtualFS,
  modulesDir: string,
  plan: InstallPlan,
  fetch: SecureFetch,
  timeoutMs: number | undefined
): Promise<void> {
  const topNames = Object.keys(plan.root);
  if (topNames.length === 0) return;
  await ensureDir(fs, modulesDir);
  for (const name of topNames) {
    await materializeNode(fs, modulesDir, plan.root[name], fetch, timeoutMs);
  }
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
  const manifest = await readJsonOr<InstalledPackageManifest | null>(
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
  entries: Array<{ name: string; range: string }>
): Promise<string> {
  const manifestPath = joinPath(cwd, 'package.json');
  const existing = await readJsonOr<ProjectManifest>(fs, manifestPath, {});
  const next: ProjectManifest = { ...existing };
  const deps = { ...(existing.dependencies ?? {}) };
  for (const entry of entries) {
    deps[entry.name] = entry.range;
  }
  next.dependencies = deps;
  await fs.writeFile(manifestPath, `${JSON.stringify(next, null, 2)}\n`);
  return manifestPath;
}

export async function installPackages(
  specs: string[],
  options: InstallOptions
): Promise<InstallPackagesResult> {
  const { fs, fetch, cwd, timeoutMs } = options;
  if (specs.length === 0) {
    return { results: [], errors: [] };
  }

  const { supplier } = buildPackumentSupplier(fetch, timeoutMs);
  const { directs, errors: stageErrors } = await stageResolveRoots(specs, supplier);
  if (directs.length === 0) {
    return { results: [], errors: stageErrors };
  }

  const rootDependencies: Record<string, string> = {};
  for (const direct of directs) {
    rootDependencies[direct.parsed.name] = direct.parsed.range;
  }

  const plan = await resolveDependencyTree({
    rootDependencies,
    fetchPackument: supplier,
  });

  const modulesDir = joinPath(cwd, 'node_modules');
  await materializePlan(fs, modulesDir, plan, fetch, timeoutMs);
  await reconcileRootBinShims(fs, modulesDir);

  const records = directs.map((d) => {
    const node = plan.root[d.parsed.name];
    if (!node) throw new Error(`installer: resolved node missing for ${d.parsed.name}`);
    return { name: d.parsed.name, range: chooseSavedRange(d.parsed, node.version) };
  });
  const manifestPath = await recordDirectDependencies(fs, cwd, records);

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

  return { results, errors: stageErrors };
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

function collectManifestEntries(manifest: ProjectManifest): ManifestEntry[] {
  const combined = new Map<string, string>();
  const devDeps = manifest.devDependencies;
  if (devDeps && typeof devDeps === 'object') {
    for (const [name, range] of Object.entries(devDeps)) {
      if (typeof name === 'string' && typeof range === 'string') {
        combined.set(name, range);
      }
    }
  }
  const deps = manifest.dependencies;
  if (deps && typeof deps === 'object') {
    for (const [name, range] of Object.entries(deps)) {
      if (typeof name === 'string' && typeof range === 'string') {
        combined.set(name, range);
      }
    }
  }
  return Array.from(combined.entries()).map(([name, range]) => ({ name, range }));
}

export async function installFromManifest(
  options: InstallOptions
): Promise<InstallFromManifestResult> {
  const { fs, fetch, cwd, timeoutMs } = options;
  const manifestPath = joinPath(cwd, 'package.json');
  if (!(await fs.exists(manifestPath))) {
    throw new ManifestNotFoundError(manifestPath);
  }
  const manifest = await readJsonOr<ProjectManifest>(fs, manifestPath, {});
  const entries = collectManifestEntries(manifest);
  if (entries.length === 0) {
    return { results: [], errors: [], empty: true };
  }

  const { supplier } = buildPackumentSupplier(fetch, timeoutMs);

  const validated: ManifestEntry[] = [];
  const errors: InstallFailure[] = [];
  for (const entry of entries) {
    try {
      const packument = await supplier(entry.name);
      resolveVersion(packument, entry.range);
      validated.push(entry);
    } catch (err) {
      errors.push({ spec: `${entry.name}@${entry.range}`, error: toError(err) });
    }
  }

  if (validated.length === 0) {
    return { results: [], errors, empty: false };
  }

  const rootDependencies: Record<string, string> = {};
  for (const entry of validated) {
    rootDependencies[entry.name] = entry.range;
  }

  const plan = await resolveDependencyTree({
    rootDependencies,
    fetchPackument: supplier,
  });

  const modulesDir = joinPath(cwd, 'node_modules');
  await materializePlan(fs, modulesDir, plan, fetch, timeoutMs);
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

  return { results, errors, empty: false };
}
