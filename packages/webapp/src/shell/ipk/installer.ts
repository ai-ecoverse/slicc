/**
 * Single-package install path for ipk (Ice Pack).
 *
 * Resolves a `<name>[@<spec>]` install argument against the npm registry,
 * downloads + extracts the tarball into `<cwd>/node_modules/<name>` on the
 * supplied VirtualFS, and records the dependency in `<cwd>/package.json`
 * without clobbering existing fields. Pure and individually testable —
 * takes an injected `SecureFetch` so it works in both floats (CLI worker
 * + extension sandbox) and in unit tests.
 *
 * M1 scope: a single named package, no transitive resolution, no lockfile,
 * no `.bin` shims. Transitive dep-tree work happens in M2 / M4.
 */

import type { SecureFetch } from 'just-bash';
import type { VirtualFS } from '../../fs/index.js';
import { fetchPackument, fetchTarball, resolveVersion } from './registry.js';
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

function packageDirFor(cwd: string, pkgName: string): string {
  if (pkgName.startsWith('@')) {
    const [scope, name] = pkgName.split('/', 2);
    return joinPath(cwd, 'node_modules', scope, name);
  }
  return joinPath(cwd, 'node_modules', pkgName);
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
  [key: string]: unknown;
}

async function recordDependency(
  fs: VirtualFS,
  cwd: string,
  pkgName: string,
  range: string
): Promise<string> {
  const manifestPath = joinPath(cwd, 'package.json');
  const existing = await readJsonOr<ProjectManifest>(fs, manifestPath, {});
  const next: ProjectManifest = { ...existing };
  const deps = { ...(existing.dependencies ?? {}) };
  deps[pkgName] = range;
  next.dependencies = deps;
  await fs.writeFile(manifestPath, `${JSON.stringify(next, null, 2)}\n`);
  return manifestPath;
}

export async function installPackage(
  spec: string,
  options: InstallOptions
): Promise<InstallResult> {
  const { fs, fetch, cwd, timeoutMs } = options;
  const parsed = parseInstallSpec(spec);
  const packument = await fetchPackument(parsed.name, fetch, { timeoutMs });
  const version = resolveVersion(packument, parsed.range);
  const versionEntry = packument.versions[version];
  if (!versionEntry?.dist?.tarball) {
    throw new Error(
      `ipk: packument for '${parsed.name}@${version}' is missing dist.tarball; cannot download`
    );
  }
  const tarballBytes = await fetchTarball(versionEntry.dist.tarball, fetch, { timeoutMs });
  const entries = readTar(gunzip(tarballBytes));

  const installDir = packageDirFor(cwd, parsed.name);
  await removeIfExists(fs, installDir);
  await ensureDir(fs, installDir);
  await writeEntries(fs, installDir, entries);

  const range = chooseSavedRange(parsed, version);
  const manifestPath = await recordDependency(fs, cwd, parsed.name, range);

  return {
    ok: true,
    name: parsed.name,
    version,
    installPath: installDir,
    range,
    manifestPath,
  };
}
