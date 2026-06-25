/**
 * Minimal `pyproject.toml` + `uv.lock` reader/writer for `di`.
 *
 * This is NOT a general TOML library — `di` owns both reads and writes, so we
 * hand-roll the exact subset we need: PEP 621 `[project]` with a string
 * `dependencies` array, and `uv.lock`'s array-of-tables (`[[package]]`) with a
 * fixed set of string fields. The field names are kept compatible with real
 * `uv.lock` v1 so a real `uv` install could read what we write, but only the
 * fields we use are emitted.
 *
 * Manifest discovery walks up from the invoking cwd looking for a
 * `pyproject.toml`, mirroring how ipk finds `package.json`.
 */

import type { VirtualFS } from '../../fs/index.js';
import { joinPath, splitPath } from '../../fs/path-utils.js';
import type { DiSource } from './types.js';

const PYPROJECT_FILE = 'pyproject.toml';
const UVLOCK_FILE = 'uv.lock';
const DEFAULT_MANIFEST_DIR = '/workspace';

/** The minimal `[project]` table `di` reads/writes. */
export interface PyProject {
  name: string;
  version: string;
  /** PEP 508 requirement strings; `di` only ever writes `name==version`. */
  dependencies: string[];
}

/** One `[[package]]` table in `uv.lock`. */
export interface LockEntry {
  name: string;
  version: string;
  source: DiSource;
  fileName: string;
  sha256: string;
}

/** PEP 503 name normalization for case/separator-insensitive comparison. */
export function normalizePackageName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[-_.]+/g, '-');
}

/** The package name portion of a `name==version` dependency string. */
export function dependencyName(dep: string): string {
  const eq = dep.indexOf('==');
  return (eq === -1 ? dep : dep.slice(0, eq)).trim();
}

/** Split a `name==version` dependency into its parts (`version` may be ''). */
export function splitDependency(dep: string): { name: string; version: string } {
  const eq = dep.indexOf('==');
  if (eq === -1) return { name: dep.trim(), version: '' };
  return { name: dep.slice(0, eq).trim(), version: dep.slice(eq + 2).trim() };
}

/**
 * Walk up from `cwd` looking for a `pyproject.toml`. Returns the directory
 * that contains it, or `null` when none exists up to the filesystem root.
 */
export async function findManifestDir(fs: VirtualFS, cwd: string): Promise<string | null> {
  let current = cwd?.startsWith('/') ? cwd : DEFAULT_MANIFEST_DIR;
  for (;;) {
    if (await fs.exists(joinPath(current, PYPROJECT_FILE))) return current;
    if (current === '/') return null;
    current = splitPath(current).dir;
  }
}

/**
 * The directory `di add` should write the manifest pair into: the nearest
 * existing `pyproject.toml`'s directory, else `/workspace`.
 */
export async function resolveManifestDir(fs: VirtualFS, cwd: string): Promise<string> {
  return (await findManifestDir(fs, cwd)) ?? DEFAULT_MANIFEST_DIR;
}

/** Strip a quote-aware trailing `# comment` from a single line. */
function stripComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === '#' && !inSingle && !inDouble) return line.slice(0, i);
  }
  return line;
}

/** Unwrap a `"..."` / `'...'` scalar, or return `null` when unquoted. */
function unquote(value: string): string | null {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return null;
}

/**
 * Collect a (possibly multi-line) TOML string array starting at `firstValue`,
 * pulling in following lines until the closing `]`. Returns the trimmed,
 * non-empty quoted strings and the index of the last line consumed.
 */
function collectArrayStrings(
  lines: string[],
  startIndex: number,
  firstValue: string
): { items: string[]; lastIndex: number } {
  let buffer = firstValue;
  let i = startIndex;
  while (!buffer.includes(']') && i + 1 < lines.length) {
    i += 1;
    buffer += `\n${stripComment(lines[i])}`;
  }
  const items: string[] = [];
  for (const m of buffer.matchAll(/["']([^"']*)["']/g)) {
    if (m[1].trim()) items.push(m[1].trim());
  }
  return { items, lastIndex: i };
}

/** Parse the `[project]` subset of a `pyproject.toml`. */
export function parsePyproject(content: string): PyProject {
  const lines = content.split('\n');
  let section = '';
  let name = 'workspace';
  let version = '0.1.0';
  let dependencies: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = stripComment(lines[i]).trim();
    if (!line) continue;
    if (line.startsWith('[')) {
      section = line;
      continue;
    }
    if (section !== '[project]') continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const rawVal = line.slice(eq + 1).trim();
    if (key === 'name') name = unquote(rawVal) ?? name;
    else if (key === 'version') version = unquote(rawVal) ?? version;
    else if (key === 'dependencies') {
      const collected = collectArrayStrings(lines, i, rawVal);
      dependencies = collected.items;
      i = collected.lastIndex;
    }
  }
  return { name, version, dependencies };
}

/** Serialize a `PyProject` back to a canonical `[project]` table. */
export function serializePyproject(project: PyProject): string {
  const body =
    project.dependencies.length === 0
      ? 'dependencies = []'
      : `dependencies = [\n${project.dependencies.map((d) => `    "${d}",`).join('\n')}\n]`;
  return `[project]\nname = "${project.name}"\nversion = "${project.version}"\n${body}\n`;
}

const LOCK_KEYS: Record<string, keyof LockEntry> = {
  name: 'name',
  version: 'version',
  source: 'source',
  file_name: 'fileName',
  sha256: 'sha256',
};

function commitLockEntry(out: LockEntry[], partial: Partial<LockEntry>): void {
  if (partial.name && partial.version && partial.source && partial.fileName && partial.sha256) {
    out.push(partial as LockEntry);
  }
}

/** Parse the `[[package]]` array-of-tables subset of a `uv.lock`. */
export function parseUvLock(content: string): LockEntry[] {
  const out: LockEntry[] = [];
  let current: Partial<LockEntry> | null = null;
  for (const raw of content.split('\n')) {
    const line = stripComment(raw).trim();
    if (!line) continue;
    if (line === '[[package]]') {
      if (current) commitLockEntry(out, current);
      current = {};
      continue;
    }
    if (line.startsWith('[')) {
      if (current) commitLockEntry(out, current);
      current = null;
      continue;
    }
    if (!current) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const field = LOCK_KEYS[line.slice(0, eq).trim()];
    if (!field) continue;
    const value = unquote(line.slice(eq + 1).trim());
    if (value === null) continue;
    if (field === 'source') current.source = value as DiSource;
    else current[field] = value;
  }
  if (current) commitLockEntry(out, current);
  return out;
}

/** Serialize `uv.lock` `[[package]]` tables in a stable name order. */
export function serializeUvLock(entries: LockEntry[]): string {
  return entries
    .map(
      (e) =>
        `[[package]]\nname = "${e.name}"\nversion = "${e.version}"\n` +
        `source = "${e.source}"\nfile_name = "${e.fileName}"\nsha256 = "${e.sha256}"\n`
    )
    .join('\n');
}

/** Idempotently upsert `name==version` into a dependency list (name-sorted). */
export function upsertDependency(deps: string[], name: string, version: string): string[] {
  const target = normalizePackageName(name);
  const next = deps.filter((d) => normalizePackageName(dependencyName(d)) !== target);
  next.push(`${name}==${version}`);
  next.sort((a, b) =>
    normalizePackageName(dependencyName(a)).localeCompare(normalizePackageName(dependencyName(b)))
  );
  return next;
}

/** Idempotently upsert a lock entry by normalized name (name-sorted). */
export function upsertLockEntry(entries: LockEntry[], entry: LockEntry): LockEntry[] {
  const target = normalizePackageName(entry.name);
  const next = entries.filter((e) => normalizePackageName(e.name) !== target);
  next.push(entry);
  next.sort((a, b) => normalizePackageName(a.name).localeCompare(normalizePackageName(b.name)));
  return next;
}

/** Read the `pyproject.toml` in `dir`, or a fresh minimal project when absent. */
export async function loadPyproject(fs: VirtualFS, dir: string): Promise<PyProject> {
  const path = joinPath(dir, PYPROJECT_FILE);
  if (!(await fs.exists(path))) {
    return { name: 'workspace', version: '0.1.0', dependencies: [] };
  }
  return parsePyproject((await fs.readFile(path)) as string);
}

/** Write `project` to `dir/pyproject.toml`, creating `dir` if needed. */
export async function savePyproject(fs: VirtualFS, dir: string, project: PyProject): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(joinPath(dir, PYPROJECT_FILE), serializePyproject(project));
}

/** Read the `uv.lock` in `dir`, or an empty list when absent. */
export async function loadUvLock(fs: VirtualFS, dir: string): Promise<LockEntry[]> {
  const path = joinPath(dir, UVLOCK_FILE);
  if (!(await fs.exists(path))) return [];
  return parseUvLock((await fs.readFile(path)) as string);
}

/** Write `entries` to `dir/uv.lock`, creating `dir` if needed. */
export async function saveUvLock(fs: VirtualFS, dir: string, entries: LockEntry[]): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(joinPath(dir, UVLOCK_FILE), serializeUvLock(entries));
}
