import type { FileContent, ReadFileOptions } from '../../fs/types.js';
import { GLOBAL_NODE_MODULES } from './global-prefix.js';

const SUPPORTED_ABI = 'emscripten';

const FALLBACK_SCOPE = '@ai-ecoverse/';
const FALLBACK_PREFIX = 'wasm-';

export interface WasmCommand {
  name: string;

  glue: string;

  wasm: string;

  argv0: string;

  pkg: string;
}

export interface ProgramFs {
  exists(path: string): Promise<boolean>;
  readDir(path: string): Promise<ReadonlyArray<{ name: string }>>;
  readFile(path: string, options?: ReadFileOptions): Promise<FileContent>;
}

export function isProgramFs(fs: unknown): fs is ProgramFs {
  const candidate = fs as Partial<ProgramFs> | null;
  return (
    typeof candidate?.exists === 'function' &&
    typeof candidate.readDir === 'function' &&
    typeof candidate.readFile === 'function'
  );
}

async function list(fs: ProgramFs, path: string): Promise<string[]> {
  return (await fs.readDir(path)).map((entry) => entry.name);
}

async function readText(fs: ProgramFs, path: string): Promise<string> {
  const raw = await fs.readFile(path, { encoding: 'utf-8' });
  return typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
}

interface CommandEntry {
  glue?: unknown;
  wasm?: unknown;
  argv0?: unknown;
}

interface PackageJson {
  name?: unknown;
  slicc?: { abi?: unknown; commands?: unknown };
}

export function isInstalledProgramPath(path: string): boolean {
  return (
    path.startsWith(`${GLOBAL_NODE_MODULES}/`) &&
    (path.endsWith('/package.json') || path.endsWith('.wasm'))
  );
}

function insidePackage(pkgDir: string, rel: unknown): string | undefined {
  if (typeof rel !== 'string' || rel.length === 0) return undefined;
  const clean = rel.replace(/^\.\//, '');
  if (clean.startsWith('/') || clean.split('/').includes('..')) return undefined;
  return `${pkgDir}/${clean}`;
}

function validCommandName(name: string): boolean {
  return /^[A-Za-z0-9._+-]+$/.test(name) && name !== '.' && name !== '..';
}

export function commandsFromManifest(pkgDir: string, pkg: PackageJson): WasmCommand[] {
  const slicc = pkg.slicc;
  if (!slicc || typeof slicc !== 'object') return [];
  if (slicc.abi !== undefined && slicc.abi !== SUPPORTED_ABI) return [];
  const commands = slicc.commands;
  if (!commands || typeof commands !== 'object') return [];
  const name = typeof pkg.name === 'string' ? pkg.name : pkgDir;
  const out: WasmCommand[] = [];
  for (const [command, raw] of Object.entries(commands as Record<string, CommandEntry>)) {
    if (!validCommandName(command) || !raw || typeof raw !== 'object') continue;
    const glue = insidePackage(pkgDir, raw.glue);
    const wasm = insidePackage(pkgDir, raw.wasm);
    if (!glue || !wasm) continue;
    const argv0 = typeof raw.argv0 === 'string' && raw.argv0 ? raw.argv0 : command;
    out.push({ name: command, glue, wasm, argv0, pkg: name });
  }
  return out;
}

async function fallbackCommands(
  fs: ProgramFs,
  pkgDir: string,
  pkg: string
): Promise<WasmCommand[]> {
  const bin = `${pkgDir}/bin`;
  let names: string[];
  try {
    names = await list(fs, bin);
  } catch {
    return [];
  }
  const present = new Set(names);
  return names
    .filter((n) => !n.endsWith('.wasm') && present.has(`${n}.wasm`) && validCommandName(n))
    .map((n) => ({ name: n, glue: `${bin}/${n}`, wasm: `${bin}/${n}.wasm`, argv0: n, pkg }));
}

async function packageCommands(fs: ProgramFs, pkgDir: string): Promise<WasmCommand[]> {
  let pkg: PackageJson;
  try {
    pkg = JSON.parse(await readText(fs, `${pkgDir}/package.json`)) as PackageJson;
  } catch {
    return [];
  }
  const declared = commandsFromManifest(pkgDir, pkg);
  if (declared.length > 0 || pkg.slicc) return declared;
  const name = typeof pkg.name === 'string' ? pkg.name : '';
  if (
    name.startsWith(FALLBACK_SCOPE) &&
    name.slice(FALLBACK_SCOPE.length).startsWith(FALLBACK_PREFIX)
  ) {
    return fallbackCommands(fs, pkgDir, name);
  }
  return [];
}

async function packageDirs(fs: ProgramFs, modulesDir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await list(fs, modulesDir);
  } catch {
    return [];
  }
  const dirs: string[] = [];
  for (const name of names.sort()) {
    if (name.startsWith('.')) continue;
    if (!name.startsWith('@')) {
      dirs.push(`${modulesDir}/${name}`);
      continue;
    }
    let scoped: string[] = [];
    try {
      scoped = await list(fs, `${modulesDir}/${name}`);
    } catch {}
    for (const sub of scoped.sort()) dirs.push(`${modulesDir}/${name}/${sub}`);
  }
  return dirs;
}

export async function scanWasmCommands(
  fs: ProgramFs,
  modulesDir: string
): Promise<Map<string, WasmCommand>> {
  const out = new Map<string, WasmCommand>();
  if (!(await fs.exists(modulesDir))) return out;
  for (const pkgDir of await packageDirs(fs, modulesDir)) {
    for (const command of await packageCommands(fs, pkgDir)) {
      if (!out.has(command.name)) out.set(command.name, command);
    }
  }
  return out;
}
