import type { VirtualFS } from '../../fs/index.js';
import { joinPath, splitPath } from '../../fs/path-utils.js';
import type { DiSource } from './types.js';

const PYPROJECT_FILE = 'pyproject.toml';
const UVLOCK_FILE = 'uv.lock';
const DEFAULT_MANIFEST_DIR = '/workspace';

export interface PyProject {
  name: string;
  version: string;

  dependencies: string[];

  raw?: string;
}

export interface LockEntry {
  name: string;
  version: string;
  source: DiSource;
  fileName: string;
  sha256: string;
}

export function normalizePackageName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[-_.]+/g, '-');
}

export function dependencyName(dep: string): string {
  const eq = dep.indexOf('==');
  return (eq === -1 ? dep : dep.slice(0, eq)).trim();
}

export function splitDependency(dep: string): { name: string; version: string } {
  const eq = dep.indexOf('==');
  if (eq === -1) return { name: dep.trim(), version: '' };
  return { name: dep.slice(0, eq).trim(), version: dep.slice(eq + 2).trim() };
}

export async function findManifestDir(fs: VirtualFS, cwd: string): Promise<string | null> {
  let current = cwd?.startsWith('/') ? cwd : DEFAULT_MANIFEST_DIR;
  for (;;) {
    if (await fs.exists(joinPath(current, PYPROJECT_FILE))) return current;
    if (current === '/') return null;
    current = splitPath(current).dir;
  }
}

export async function resolveManifestDir(fs: VirtualFS, cwd: string): Promise<string> {
  return (await findManifestDir(fs, cwd)) ?? DEFAULT_MANIFEST_DIR;
}

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

function unquote(value: string): string | null {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return null;
}

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

function serializeDependencies(dependencies: string[]): string {
  return dependencies.length === 0
    ? 'dependencies = []'
    : `dependencies = [\n${dependencies.map((d) => `    "${d}",`).join('\n')}\n]`;
}

export function serializePyproject(project: PyProject): string {
  const body = serializeDependencies(project.dependencies);
  return `[project]\nname = "${project.name}"\nversion = "${project.version}"\n${body}\n`;
}

interface ProjectDepsLocation {
  depsStart: number;

  depsEnd: number;

  projectHeaderIndex: number;

  projectSectionEnd: number;
}

function arrayEndIndex(lines: string[], start: number): number {
  let buffer = stripComment(lines[start]);
  let j = start;
  while (!buffer.includes(']') && j + 1 < lines.length) {
    j += 1;
    buffer += `\n${stripComment(lines[j])}`;
  }
  return j;
}

function locateProjectDeps(lines: string[]): ProjectDepsLocation {
  const loc: ProjectDepsLocation = {
    depsStart: -1,
    depsEnd: -1,
    projectHeaderIndex: -1,
    projectSectionEnd: -1,
  };
  let section = '';
  for (let i = 0; i < lines.length; i++) {
    const stripped = stripComment(lines[i]).trim();
    if (stripped.startsWith('[')) {
      if (
        loc.projectHeaderIndex !== -1 &&
        loc.projectSectionEnd === -1 &&
        i > loc.projectHeaderIndex
      ) {
        loc.projectSectionEnd = i;
      }
      section = stripped;
      if (stripped === '[project]') loc.projectHeaderIndex = i;
      continue;
    }
    if (section !== '[project]' || loc.depsStart !== -1) continue;
    const eq = stripped.indexOf('=');
    if (eq === -1 || stripped.slice(0, eq).trim() !== 'dependencies') continue;
    loc.depsStart = i;
    loc.depsEnd = arrayEndIndex(lines, i);
  }
  return loc;
}

export function updatePyproject(content: string, project: PyProject): string {
  const blockLines = serializeDependencies(project.dependencies).split('\n');
  const lines = content.split('\n');
  const { depsStart, depsEnd, projectHeaderIndex, projectSectionEnd } = locateProjectDeps(lines);

  if (depsStart !== -1) {
    lines.splice(depsStart, depsEnd - depsStart + 1, ...blockLines);
    return lines.join('\n');
  }
  if (projectHeaderIndex !== -1) {
    const insertAt = projectSectionEnd === -1 ? lines.length : projectSectionEnd;
    lines.splice(insertAt, 0, ...blockLines);
    return lines.join('\n');
  }
  const separator = content.length === 0 || content.endsWith('\n') ? '' : '\n';
  return `${content}${separator}\n${serializePyproject(project)}`;
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

export function serializeUvLock(entries: LockEntry[]): string {
  return entries
    .map(
      (e) =>
        `[[package]]\nname = "${e.name}"\nversion = "${e.version}"\n` +
        `source = "${e.source}"\nfile_name = "${e.fileName}"\nsha256 = "${e.sha256}"\n`
    )
    .join('\n');
}

export function upsertDependency(deps: string[], name: string, version: string): string[] {
  const target = normalizePackageName(name);
  const next = deps.filter((d) => normalizePackageName(dependencyName(d)) !== target);
  next.push(`${name}==${version}`);
  next.sort((a, b) =>
    normalizePackageName(dependencyName(a)).localeCompare(normalizePackageName(dependencyName(b)))
  );
  return next;
}

export function upsertLockEntry(entries: LockEntry[], entry: LockEntry): LockEntry[] {
  const target = normalizePackageName(entry.name);
  const next = entries.filter((e) => normalizePackageName(e.name) !== target);
  next.push(entry);
  next.sort((a, b) => normalizePackageName(a.name).localeCompare(normalizePackageName(b.name)));
  return next;
}

export async function loadPyproject(fs: VirtualFS, dir: string): Promise<PyProject> {
  const path = joinPath(dir, PYPROJECT_FILE);
  if (!(await fs.exists(path))) {
    return { name: 'workspace', version: '0.1.0', dependencies: [] };
  }
  const content = (await fs.readFile(path)) as string;
  return { ...parsePyproject(content), raw: content };
}

export async function savePyproject(fs: VirtualFS, dir: string, project: PyProject): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const content =
    project.raw === undefined ? serializePyproject(project) : updatePyproject(project.raw, project);
  await fs.writeFile(joinPath(dir, PYPROJECT_FILE), content);
}

export async function loadUvLock(fs: VirtualFS, dir: string): Promise<LockEntry[]> {
  const path = joinPath(dir, UVLOCK_FILE);
  if (!(await fs.exists(path))) return [];
  return parseUvLock((await fs.readFile(path)) as string);
}

export async function saveUvLock(fs: VirtualFS, dir: string, entries: LockEntry[]): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(joinPath(dir, UVLOCK_FILE), serializeUvLock(entries));
}
