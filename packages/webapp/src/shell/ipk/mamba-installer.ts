import type { SecureFetch } from 'just-bash';
import { type EntryType, FsError, type MetadataUpdate, type VirtualFS } from '../../fs/index.js';
import { joinPath } from '../../fs/path-utils.js';
import { normalizeFileMode } from './file-modes.js';
import { type ExtractedCondaEntry, extractCondaArchive } from './mamba-extract.js';
import { CONDA_META_DIR, CONDA_PREFIX, DEFAULT_CONDA_CHANNELS } from './mamba-prefix.js';
import {
  type CondaPackageRecord,
  downloadCondaPackage,
  parseCondaSpec,
  type ResolveCondaPackageOptions,
  resolveCondaPackage,
} from './mamba-repodata.js';
import { readBackFault } from './read-back.js';

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

async function ensureDir(fs: VirtualFS, path: string): Promise<void> {
  await fs.mkdir(path, { recursive: true });
}

async function removeIfExists(fs: VirtualFS, path: string): Promise<void> {
  try {
    await fs.lstat(path);
  } catch {
    return;
  }
  await fs.rm(path, { recursive: true });
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

interface PlannedFile {
  rel: string;
  target: string;
  bytes: Uint8Array;
  mode: number;
}

interface PlannedLink {
  rel: string;
  path: string;
  target: string;
}

interface WritePlan {
  files: PlannedFile[];
  links: PlannedLink[];
}

function planEntries(prefix: string, entries: ExtractedCondaEntry[]): WritePlan {
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

  const isInfo = (e: ExtractedCondaEntry) => e.path === 'info' || e.path.startsWith('info/');
  const files: PlannedFile[] = [];
  const links: PlannedLink[] = [];
  for (const entry of entries) {
    if (entry.directory || isInfo(entry)) continue;
    if (entry.symlink) {
      links.push({ rel: entry.path, path: joinPath(prefix, entry.path), target: entry.symlink });
      continue;
    }
    const placeholder = placeholders.get(entry.path);
    const bytes = placeholder
      ? relocatePrefixBytes(entry.bytes, placeholder, prefix, pathsMeta.get(entry.path)?.file_mode)
      : entry.bytes;
    files.push({
      rel: entry.path,
      target: joinPath(prefix, entry.path),
      bytes,
      mode: normalizeFileMode(entry.mode),
    });
  }
  return { files, links };
}

function plannedPaths(plan: WritePlan): string[] {
  return [...plan.files.map((f) => f.rel), ...plan.links.map((l) => l.rel)];
}

async function entryKind(fs: VirtualFS, path: string): Promise<EntryType | null> {
  try {
    return (await fs.lstat(path)).type;
  } catch {
    return null;
  }
}

async function writePlan(fs: VirtualFS, plan: WritePlan): Promise<void> {
  for (const file of plan.files) {
    const lastSlash = file.target.lastIndexOf('/');
    if (lastSlash > 0) {
      await ensureDir(fs, file.target.slice(0, lastSlash));
    }

    const kind = await entryKind(fs, file.target);
    if (kind !== null && kind !== 'file') await removeIfExists(fs, file.target);
    await fs.writeFile(file.target, file.bytes);
  }

  const modes: MetadataUpdate[] = plan.files.map((f) => ({ path: f.target, mode: f.mode }));
  await fs.updateMetadataBatch(modes);

  if (plan.links.length > 0) {
    for (const link of plan.links) await removeIfExists(fs, link.path);
    await fs.symlinkBatch(plan.links.map((l) => ({ target: l.target, path: l.path })));
  }
}

async function removePlan(fs: VirtualFS, plan: WritePlan): Promise<void> {
  for (const path of [...plan.files.map((f) => f.target), ...plan.links.map((l) => l.path)]) {
    await removeIfExists(fs, path);
  }
}

async function findWriteFaults(fs: VirtualFS, plan: WritePlan): Promise<string[]> {
  const faults: string[] = [];
  for (const file of plan.files) {
    const kind = await entryKind(fs, file.target);
    if (kind !== 'file' && kind !== null) {
      faults.push(`${file.target}: a ${kind}, not a regular file`);
      continue;
    }
    const fault = await readBackFault(fs, file.target, file.bytes);
    if (fault !== null) faults.push(`${file.target}: ${fault}`);
  }
  for (const link of plan.links) {
    let actual: string;
    try {
      actual = await fs.readlink(link.path);
    } catch (err) {
      faults.push(`${link.path}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (actual !== link.target) faults.push(`${link.path}: links to ${actual}, not ${link.target}`);
  }
  return faults;
}

function condaMetaText(record: CondaPackageRecord, files: string[]): string {
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
  return `${JSON.stringify(body, null, 2)}\n`;
}

async function extractVerified(fs: VirtualFS, plan: WritePlan, label: string): Promise<string[]> {
  await writePlan(fs, plan);
  if ((await findWriteFaults(fs, plan)).length === 0) return plannedPaths(plan);
  await removePlan(fs, plan);
  await writePlan(fs, plan);
  const faults = await findWriteFaults(fs, plan);
  if (faults.length === 0) return plannedPaths(plan);

  await removePlan(fs, plan);
  throw new Error(
    `mamba: ${label} does not match its archive after re-extracting: ${faults.join('; ')}`
  );
}

async function writeCondaMeta(
  fs: VirtualFS,
  prefix: string,
  record: CondaPackageRecord,
  files: string[]
): Promise<void> {
  await ensureDir(fs, joinPath(prefix, 'conda-meta'));
  const path = metaPath(prefix, record);
  const text = condaMetaText(record, files);
  const expected = new TextEncoder().encode(text);
  for (let attempt = 1; ; attempt++) {
    await fs.writeFile(path, text);
    const fault = await readBackFault(fs, path, expected);
    if (fault === null) return;
    if (attempt === 2) {
      await removeIfExists(fs, path);
      throw new Error(`mamba: ${path} does not read back after writing it twice (${fault})`);
    }
  }
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

  const existing = await readCondaMeta(options.fs, prefix);
  const prior = [...existing.packages, ...existing.broken].filter((p) => p.name === record.name);
  for (let i = 0; i < prior.length; i++) {
    await uninstallCondaPackage(record.name, { fs: options.fs, prefix });
  }

  const plan = planEntries(prefix, entries);
  const label = `${record.name}-${record.version}-${record.build}`;
  const files = await extractVerified(options.fs, plan, label);
  try {
    await writeCondaMeta(options.fs, prefix, record, files);
  } catch (err) {
    await removePlan(options.fs, plan);
    throw err;
  }

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

export interface BrokenCondaRecord {
  name: string;
  path: string;
  error: string;
}

export interface CondaMetaListing {
  packages: InstalledCondaPackage[];
  broken: BrokenCondaRecord[];
}

function nameFromMetaFilename(filename: string): string {
  return (
    filename
      .replace(/\.json$/, '')
      .split('-')
      .slice(0, -2)
      .join('-') || filename
  );
}

function isMissing(err: unknown): boolean {
  if (err instanceof FsError && err.code === 'ENOENT') return true;
  return err instanceof Error && /ENOENT/.test(err.message);
}

export async function readCondaMeta(
  fs: VirtualFS,
  prefix: string = CONDA_PREFIX
): Promise<CondaMetaListing> {
  const metaDir = joinPath(prefix, 'conda-meta');
  const listing: CondaMetaListing = { packages: [], broken: [] };
  if (!(await fs.exists(metaDir))) return listing;
  let names: string[];
  try {
    const entries = await fs.readDir(metaDir);
    names = entries.map((e) => e.name).filter((n) => n.endsWith('.json'));
  } catch {
    return listing;
  }

  for (const name of names.sort()) {
    const path = joinPath(metaDir, name);
    let meta: {
      name?: string;
      version?: string;
      build?: string;
      channel?: string;
      filename?: string;
      files?: string[];
    } | null;
    try {
      meta = JSON.parse((await fs.readFile(path, { encoding: 'utf-8' })) as string);
    } catch (err) {
      if (isMissing(err)) continue;
      const error = err instanceof Error ? err.message : String(err);
      listing.broken.push({ name: nameFromMetaFilename(name), path, error });
      continue;
    }
    if (!meta?.name || !meta.version || !meta.build) {
      const error = 'missing name, version or build';
      listing.broken.push({ name: nameFromMetaFilename(name), path, error });
      continue;
    }
    listing.packages.push({
      name: meta.name,
      version: meta.version,
      build: meta.build,
      channel: meta.channel,
      filename: meta.filename,
      files: Array.isArray(meta.files) ? meta.files : [],
    });
  }
  return listing;
}

export async function listInstalledCondaPackages(
  fs: VirtualFS,
  prefix: string = CONDA_PREFIX
): Promise<InstalledCondaPackage[]> {
  return (await readCondaMeta(fs, prefix)).packages;
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

  brokenRecord?: string;
}

export async function uninstallCondaPackage(
  name: string,
  options: MambaUninstallOptions
): Promise<MambaUninstallResult> {
  const prefix = options.prefix ?? CONDA_PREFIX;
  const { packages, broken } = await readCondaMeta(options.fs, prefix);
  const match = packages.find((p) => p.name === name);
  if (!match) {
    const record = broken.find((b) => b.name === name);
    if (!record) return { name, removed: false };
    await removeIfExists(options.fs, record.path);
    return { name, removed: true, brokenRecord: record.path };
  }

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
