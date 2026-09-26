import type { SecureFetch } from 'just-bash';
import { FsError, type VirtualFS } from '../../fs/index.js';
import { type ExtractedCondaEntry, extractCondaArchive } from './mamba-extract.js';
import { CONDA_META_DIR, CONDA_PREFIX, DEFAULT_CONDA_CHANNELS } from './mamba-prefix.js';
import {
  type CondaPackageRecord,
  downloadCondaPackage,
  parseCondaSpec,
  type ResolveCondaPackageOptions,
  resolveCondaPackage,
} from './mamba-repodata.js';

export { CONDA_META_DIR, CONDA_PREFIX, DEFAULT_CONDA_CHANNELS };

export interface MambaInstallOptions {
  fs: VirtualFS;
  fetch: SecureFetch;

  prefix?: string;
  channels?: readonly string[];
  platform?: string;
  timeoutMs?: number;
  indexes?: Map<string, import('./mamba-repodata.js').RepodataIndex>;
}

export interface MambaInstallResult {
  ok: true;
  name: string;
  version: string;
  build: string;
  prefix: string;
  filename: string;
  files: number;
  channel: string;
}

export interface MambaInstallFailure {
  spec: string;
  error: Error;
}

export interface MambaInstallPackagesResult {
  results: MambaInstallResult[];
  errors: MambaInstallFailure[];
}

export interface InstalledCondaPackage {
  name: string;
  version: string;
  build: string;
  channel?: string;
  filename?: string;
  files: string[];
}

function joinPath(base: string, ...parts: string[]): string {
  const segments = [base, ...parts]
    .join('/')
    .split('/')
    .filter((p) => p.length > 0);
  return `/${segments.join('/')}`;
}

async function ensureDir(fs: VirtualFS, path: string): Promise<void> {
  await fs.mkdir(path, { recursive: true });
}

async function removeIfExists(fs: VirtualFS, path: string): Promise<void> {
  if (await fs.exists(path)) {
    await fs.rm(path, { recursive: true });
  }
}

function metaFilename(rec: Pick<CondaPackageRecord, 'name' | 'version' | 'build'>): string {
  return `${rec.name}-${rec.version}-${rec.build}.json`;
}

function metaPath(
  prefix: string,
  rec: Pick<CondaPackageRecord, 'name' | 'version' | 'build'>
): string {
  return joinPath(prefix, 'conda-meta', metaFilename(rec));
}

interface PathsJsonPath {
  _path?: string;
  prefix_placeholder?: string | null;
  file_mode?: string | null;
}

function prefixPlaceholdersFromEntries(entries: ExtractedCondaEntry[]): Map<string, string> {
  const info = entries.find((e) => e.path === 'info/paths.json' && !e.symlink);
  if (!info) return new Map();
  try {
    const parsed = JSON.parse(new TextDecoder().decode(info.bytes)) as {
      paths?: PathsJsonPath[];
    };
    const out = new Map<string, string>();
    for (const p of parsed.paths ?? []) {
      if (
        typeof p._path === 'string' &&
        typeof p.prefix_placeholder === 'string' &&
        p.prefix_placeholder.length > 0
      ) {
        out.set(p._path, p.prefix_placeholder);
      }
    }
    return out;
  } catch {
    return new Map();
  }
}

export function relocatePrefixBytes(
  bytes: Uint8Array,
  placeholder: string,
  newPrefix: string,
  fileMode?: string | null
): Uint8Array {
  const enc = new TextEncoder();
  const needle = enc.encode(placeholder);
  if (needle.length === 0) return bytes;

  if (fileMode === 'text') {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    if (!text.includes(placeholder)) return bytes;
    return enc.encode(text.split(placeholder).join(newPrefix));
  }

  const replacement = enc.encode(newPrefix);
  if (replacement.length > needle.length) {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    if (text.includes(placeholder)) {
      return enc.encode(text.split(placeholder).join(newPrefix));
    }
    return bytes;
  }

  const out = new Uint8Array(bytes);
  for (let i = 0; i <= out.length - needle.length; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (out[i + j] !== needle[j]) {
        match = false;
        break;
      }
    }
    if (!match) continue;
    out.set(replacement, i);
    out.fill(0, i + replacement.length, i + needle.length);
    i += needle.length - 1;
  }
  return out;
}

async function writeEntries(
  fs: VirtualFS,
  prefix: string,
  entries: ExtractedCondaEntry[]
): Promise<string[]> {
  const placeholders = prefixPlaceholdersFromEntries(entries);
  const pathsMeta = new Map<string, PathsJsonPath>();
  const info = entries.find((e) => e.path === 'info/paths.json' && !e.symlink);
  if (info) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(info.bytes)) as {
        paths?: PathsJsonPath[];
      };
      for (const p of parsed.paths ?? []) {
        if (typeof p._path === 'string') pathsMeta.set(p._path, p);
      }
    } catch {}
  }

  const written: string[] = [];

  const files = entries.filter((e) => !e.symlink && !e.directory);
  const links = entries.filter((e) => e.symlink);

  for (const entry of files) {
    if (entry.path === 'info' || entry.path.startsWith('info/')) continue;
    const target = joinPath(prefix, entry.path);
    const lastSlash = target.lastIndexOf('/');
    if (lastSlash > 0) {
      await ensureDir(fs, target.slice(0, lastSlash));
    }
    let bytes = entry.bytes;
    const placeholder = placeholders.get(entry.path);
    if (placeholder) {
      bytes = relocatePrefixBytes(bytes, placeholder, prefix, pathsMeta.get(entry.path)?.file_mode);
    }
    await fs.writeFile(target, bytes);
    written.push(entry.path);
  }

  for (const entry of links) {
    if (entry.path === 'info' || entry.path.startsWith('info/')) continue;
    const target = joinPath(prefix, entry.path);
    const lastSlash = target.lastIndexOf('/');
    if (lastSlash > 0) {
      await ensureDir(fs, target.slice(0, lastSlash));
    }
    await fs.symlink(entry.symlink!, target);
    written.push(entry.path);
  }

  return written;
}

async function writeCondaMeta(
  fs: VirtualFS,
  prefix: string,
  record: CondaPackageRecord,
  files: string[]
): Promise<void> {
  await ensureDir(fs, joinPath(prefix, 'conda-meta'));
  const body = {
    name: record.name,
    version: record.version,
    build: record.build,
    build_number: record.build_number ?? 0,
    channel: record.channel,
    filename: record.filename,
    depends: record.depends ?? [],
    files,
    paths_data: files.map((f) => ({ _path: f })),
    extracted_package_dir: '',
    requested_spec: `${record.name}=${record.version}=${record.build}`,
  };
  await fs.writeFile(metaPath(prefix, record), `${JSON.stringify(body, null, 2)}\n`);
}

export async function installCondaPackage(
  spec: string,
  options: MambaInstallOptions
): Promise<MambaInstallResult> {
  const prefix = options.prefix ?? CONDA_PREFIX;
  const resolveOpts: ResolveCondaPackageOptions = {
    fetch: options.fetch,
    channels: options.channels ?? DEFAULT_CONDA_CHANNELS,
    platform: options.platform,
    timeoutMs: options.timeoutMs,
    indexes: options.indexes,
  };
  const record = await resolveCondaPackage(spec, resolveOpts);
  const archive = await downloadCondaPackage(record, options.fetch, {
    timeoutMs: options.timeoutMs,
  });
  const entries = extractCondaArchive(archive, record.filename);

  await ensureDir(options.fs, prefix);

  const existing = await listInstalledCondaPackages(options.fs, prefix);
  for (const prev of existing.filter((p) => p.name === record.name)) {
    await uninstallCondaPackage(prev.name, { fs: options.fs, prefix });
  }

  const files = await writeEntries(options.fs, prefix, entries);
  await writeCondaMeta(options.fs, prefix, record, files);

  return {
    ok: true,
    name: record.name,
    version: record.version,
    build: record.build,
    prefix,
    filename: record.filename,
    files: files.length,
    channel: record.channel,
  };
}

export async function installCondaPackages(
  specs: string[],
  options: MambaInstallOptions
): Promise<MambaInstallPackagesResult> {
  const results: MambaInstallResult[] = [];
  const errors: MambaInstallFailure[] = [];

  const indexes = options.indexes ?? new Map();
  for (const spec of specs) {
    try {
      parseCondaSpec(spec);
      const result = await installCondaPackage(spec, { ...options, indexes });
      results.push(result);
    } catch (err) {
      errors.push({
        spec,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }
  return { results, errors };
}

async function readJsonOrNull<T>(fs: VirtualFS, path: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(path, { encoding: 'utf-8' });
    return JSON.parse(raw as string) as T;
  } catch (err) {
    if (err instanceof FsError && err.code === 'ENOENT') return null;
    if (err instanceof Error && /ENOENT/.test(err.message)) return null;
    throw err;
  }
}

export async function listInstalledCondaPackages(
  fs: VirtualFS,
  prefix: string = CONDA_PREFIX
): Promise<InstalledCondaPackage[]> {
  const metaDir = joinPath(prefix, 'conda-meta');
  if (!(await fs.exists(metaDir))) return [];
  let names: string[];
  try {
    const entries = await fs.readDir(metaDir);
    names = entries.map((e) => e.name).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }

  const packages: InstalledCondaPackage[] = [];
  for (const name of names.sort()) {
    const meta = await readJsonOrNull<{
      name?: string;
      version?: string;
      build?: string;
      channel?: string;
      filename?: string;
      files?: string[];
    }>(fs, joinPath(metaDir, name));
    if (!meta?.name || !meta.version || !meta.build) continue;
    packages.push({
      name: meta.name,
      version: meta.version,
      build: meta.build,
      channel: meta.channel,
      filename: meta.filename,
      files: Array.isArray(meta.files) ? meta.files : [],
    });
  }
  return packages;
}

export interface MambaUninstallOptions {
  fs: VirtualFS;
  prefix?: string;
}

export interface MambaUninstallResult {
  name: string;
  removed: boolean;
  version?: string;
  build?: string;
}

export async function uninstallCondaPackage(
  name: string,
  options: MambaUninstallOptions
): Promise<MambaUninstallResult> {
  const prefix = options.prefix ?? CONDA_PREFIX;
  const installed = await listInstalledCondaPackages(options.fs, prefix);
  const match = installed.find((p) => p.name === name);
  if (!match) return { name, removed: false };

  for (const rel of match.files) {
    await removeIfExists(options.fs, joinPath(prefix, rel));
  }
  await removeIfExists(options.fs, metaPath(prefix, match));
  return {
    name,
    removed: true,
    version: match.version,
    build: match.build,
  };
}

export async function uninstallCondaPackages(
  names: string[],
  options: MambaUninstallOptions
): Promise<{ results: MambaUninstallResult[]; errors: MambaInstallFailure[] }> {
  const results: MambaUninstallResult[] = [];
  const errors: MambaInstallFailure[] = [];
  for (const name of names) {
    try {
      results.push(await uninstallCondaPackage(name, options));
    } catch (err) {
      errors.push({
        spec: name,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }
  return { results, errors };
}
